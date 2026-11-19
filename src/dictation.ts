/*
 * Live dictation. The browser streams 16 kHz, 16-bit mono PCM over a WebSocket and Deepgram Flux
 * sends transcript events back while the visitor is still speaking, so text appears as they talk
 * instead of after a whole recording uploads. The Worker sits in the middle only to cap each
 * session's length and size; it passes frames through unchanged.
 */
import { MODELS } from "./models";

/**
 * Live dictation socket. It sits under `/agents/` so hosts that forward that prefix carry it too.
 * It lives here, not in `index.ts`: the runtime treats every export of the main module as an
 * entrypoint and refuses to start when one is a plain string.
 */
export const DICTATION_PATH = "/agents/dictation";
/** Sample rate the browser sends. Flux needs it as a string. */
export const DICTATION_SAMPLE_RATE = 16_000;
/** One dictation session ends after this long, however it is going. */
export const MAX_DICTATION_MS = 60_000;
/** Audio bytes allowed per session: 60 seconds of 16 kHz 16-bit mono, plus slack. */
const MAX_DICTATION_BYTES = (MAX_DICTATION_MS / 1000) * DICTATION_SAMPLE_RATE * 2 * 1.1;
/** Largest text frame a browser may send (a stop request). Larger ones close the session. */
const MAX_TEXT_FRAME = 256;

type DictationEnv = Pick<Env, "AI">;

/** Closes a socket, ignoring the error a socket that is already closed throws. */
function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}

/**
 * Opens Flux and joins it to a new socket for the browser.
 *
 * @returns A 101 response carrying the browser's end, or 502 when Flux cannot be reached.
 */
export async function openDictation(env: DictationEnv): Promise<Response> {
  let upstream: WebSocket;
  try {
    // Flux's parameters must be strings. Optional tuning stays out until it is measured.
    const response = (await env.AI.run(
      MODELS.stt.streaming as never,
      { encoding: "linear16", sample_rate: String(DICTATION_SAMPLE_RATE) } as never,
      { websocket: true } as never,
    )) as unknown as Response;
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) throw new Error(`Flux answered ${response.status}.`);
    upstream = socket;
  } catch (error) {
    console.error("dictation unavailable", error instanceof Error ? error.message : "unknown error");
    return new Response("Dictation is unavailable", { status: 502 });
  }

  const [browserEnd, workerEnd] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  workerEnd.accept();
  upstream.accept();
  // With current compatibility dates, binary frames arrive as Blobs by default. Sending a Blob on
  // would deliver the text "[object Blob]" to Flux instead of audio, so read them as ArrayBuffers.
  workerEnd.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";
  let bytes = 0;
  const end = (code: number, reason: string) => {
    clearTimeout(timer);
    closeQuietly(workerEnd, code, reason);
    closeQuietly(upstream, 1000, reason);
  };
  const timer = setTimeout(() => end(1000, "Time limit"), MAX_DICTATION_MS);

  workerEnd.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      // The browser sends text only to finish early; Flux takes a CloseStream control message.
      if (event.data.length > MAX_TEXT_FRAME) return end(1009, "Frame too large");
      upstream.send(JSON.stringify({ type: "CloseStream" }));
      return;
    }
    bytes += (event.data as ArrayBuffer).byteLength;
    if (bytes > MAX_DICTATION_BYTES) return end(1009, "Too much audio");
    upstream.send(event.data as ArrayBuffer);
  });
  // Flux sends JSON text events. Anything else is dropped, so only transcripts reach the browser.
  upstream.addEventListener("message", (event) => {
    if (typeof event.data === "string") workerEnd.send(event.data);
  });
  workerEnd.addEventListener("close", () => end(1000, "Browser closed"));
  upstream.addEventListener("close", () => end(1000, "Transcriber closed"));
  workerEnd.addEventListener("error", () => end(1011, "Browser error"));
  upstream.addEventListener("error", () => end(1011, "Transcriber error"));

  return new Response(null, { status: 101, webSocket: browserEnd });
}
