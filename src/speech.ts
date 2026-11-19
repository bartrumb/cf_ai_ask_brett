/*
 * Speech-to-text and text-to-speech calls through AI Gateway, each with a fallback model and an
 * offline path. `CodexGuardAgent` handles validation, rate limits and redaction around these calls.
 */
import { Buffer } from "node:buffer";
import type { CommentarySource } from "./domain/types";
import { gatewayMetadata, gatewayOptions, type GatewayContext } from "./gateway";
import { isOffline } from "./llm";
import { MODELS } from "./models";

/** Fixed transcript returned in offline mode. It triggers rules, so the voice flow can be tried. */
export const OFFLINE_TRANSCRIPT = "Drop the legacy orders table and skip the integration tests in CI.";

/** Time allowed for each speech model, so both attempts fit inside the browser's 30-second call limit. */
const SPEECH_TIMEOUT_MS = 12_000;

/** Bindings needed for speech calls. */
type SpeechEnv = Pick<Env, "AI" | "AI_MODE" | "AI_GATEWAY_ID"> & { AI_GATEWAY_TOKEN?: string };
/** Where a successful speech result came from. */
type Source = Exclude<CommentarySource, "unavailable">;
/** Loose signature for `env.AI.run`, which is called here with model-specific input shapes. */
type RunModel = (model: string, input: unknown, options: unknown) => Promise<unknown>;

/** Result of speech recognition. The model is null in offline mode. */
export interface Transcript {
  text: string;
  source: Source;
  model: string | null;
}

/** Base64 audio returned to the browser. The model is null in offline mode. */
export interface SpokenAudio {
  audio: string;
  mimeType: string;
  source: Source;
  model: string | null;
}

// The SDK's audio helpers omit the gateway option, so these calls set it directly.
function runner(env: SpeechEnv): RunModel {
  return env.AI.run.bind(env.AI) as unknown as RunModel;
}

/**
 * Reads the Deepgram Nova response shape.
 *
 * @throws Error when no transcript string is present, which triggers the fallback model.
 */
function readNovaTranscript(output: unknown): string {
  const result = output as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } };
  const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") throw new Error("Unexpected transcription response.");
  return transcript.trim();
}

/**
 * Reads the Whisper response shape.
 *
 * @throws Error when no text string is present.
 */
function readWhisperTranscript(output: unknown): string {
  const text = (output as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Unexpected transcription response.");
  return text.trim();
}

/**
 * Sends audio to Nova through the gateway's HTTP endpoint. The Workers AI binding cannot do this,
 * because AI Gateway rejects the streamed audio body Nova requires on that path.
 *
 * @throws Error when the gateway refuses the request or returns an unexpected response.
 */
async function transcribeWithNova(env: SpeechEnv, token: string, wav: Uint8Array, context: GatewayContext): Promise<string> {
  const base = (await env.AI.gateway(env.AI_GATEWAY_ID).getUrl("workers-ai")).replace(/\/$/, "");
  const response = await fetch(`${base}/${MODELS.stt.primary}?smart_format=true&punctuate=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "cf-aig-authorization": `Bearer ${token}`,
      "cf-aig-collect-log-payload": "false",
      "cf-aig-metadata": JSON.stringify(gatewayMetadata(context)),
      "cf-aig-skip-cache": "true",
      "Content-Type": "audio/wav",
    },
    body: wav,
  });
  if (!response.ok) throw new Error(`Nova request failed with status ${response.status}.`);
  const output = (await response.json()) as { result?: unknown };
  return readNovaTranscript(output.result ?? output);
}

/**
 * Transcribes a validated WAV file. Nova runs only when a gateway token is configured, so audio
 * never bypasses AI Gateway. Whisper handles every other case and any Nova failure.
 *
 * @param wav - Bytes already checked by `decodeWav`.
 * @param context - Gateway metadata for the request.
 * @throws The Whisper error when no model can produce a transcript.
 */
export async function transcribeAudio(env: SpeechEnv, wav: Uint8Array, context: GatewayContext): Promise<Transcript> {
  if (isOffline(env)) return { text: OFFLINE_TRANSCRIPT, source: "offline", model: null };

  if (env.AI_GATEWAY_TOKEN) {
    try {
      const text = await transcribeWithNova(env, env.AI_GATEWAY_TOKEN, wav, context);
      return { text, source: "workers-ai", model: MODELS.stt.primary };
    } catch (error) {
      console.warn("primary transcription failed", error instanceof Error ? error.message : "unknown error");
    }
  }
  const run = runner(env);
  // Recordings are not needed to monitor spend, so ask the gateway not to log them.
  const options = {
    gateway: gatewayOptions(env, context),
    extraHeaders: { "cf-aig-collect-log-payload": "false" },
  };
  // Whisper accepts base64 audio, which AI Gateway can carry through the binding.
  const output = await run(
    MODELS.stt.secondary,
    { audio: Buffer.from(wav).toString("base64"), task: "transcribe", language: "en", vad_filter: true },
    options,
  );
  return { text: readWhisperTranscript(output), source: "workers-ai", model: MODELS.stt.secondary };
}

/**
 * Converts a raw speech response to base64.
 *
 * @throws Error on a non-success status or an empty body, which triggers the fallback model.
 */
async function readAudioResponse(output: unknown): Promise<string> {
  const response = output instanceof Response ? output : new Response(output as BodyInit);
  if (!response.ok) throw new Error(`Speech request failed with status ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("The speech response was empty.");
  return Buffer.from(bytes).toString("base64");
}

/** A short tone that lets offline runs exercise the audio path for free. */
function offlineTone(): string {
  const sampleRate = 16_000;
  const samples = sampleRate / 2;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 6_000), 44 + index * 2);
  }
  return buffer.toString("base64");
}

/**
 * Synthesizes MP3 speech, trying the secondary model after any primary failure.
 *
 * @param text - Text already prepared and length-limited by `domain/audio.ts`.
 * @param context - Gateway metadata for the request.
 * @throws The secondary model's error when both models fail.
 */
export async function synthesizeSpeech(
  env: SpeechEnv,
  text: string,
  context: GatewayContext,
  timeoutMs = SPEECH_TIMEOUT_MS,
): Promise<SpokenAudio> {
  if (isOffline(env)) return { audio: offlineTone(), mimeType: "audio/wav", source: "offline", model: null };

  const run = runner(env);
  const options = { gateway: gatewayOptions(env, context), returnRawResponse: true };
  const input = { text, speaker: "luna", encoding: "mp3" };
  // The limit covers the whole download, because a slow stream can start promptly and then stall.
  const speak = async (model: string): Promise<SpokenAudio> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Speech request timed out."));
      }, timeoutMs);
    });
    try {
      const request = (async () => readAudioResponse(await run(model, input, { ...options, signal: controller.signal })))();
      const audio = await Promise.race([request, timeout]);
      return { audio, mimeType: "audio/mpeg", source: "workers-ai", model };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await speak(MODELS.tts.primary);
  } catch (error) {
    console.warn("primary speech failed", error instanceof Error ? error.message : "unknown error");
  }
  return speak(MODELS.tts.secondary);
}
