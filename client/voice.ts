/*
 * Browser audio helpers: microphone capture, conversion to the WAV format the server accepts, and
 * playback of returned speech. `main.ts` owns the related UI state.
 */
/** Output sample rate. With 30 seconds of 16-bit mono it stays within `MAX_AUDIO_BYTES`. */
const TARGET_SAMPLE_RATE = 16_000;
/** Recording stops automatically after this long. */
export const MAX_RECORDING_MS = 30_000;

/** Encodes mono samples as a 16-bit PCM WAV file, clipping values outside the valid range. */
function toWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  });
  return new Uint8Array(buffer);
}

/** Encodes bytes in chunks, because spreading a whole recording could exceed argument limits. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Converts a browser recording to the 16 kHz mono WAV the server accepts.
 * Recorders produce browser-specific formats, so the audio is decoded and resampled here.
 *
 * @throws DOMException when the browser cannot decode the recording.
 */
async function encodeRecording(blob: Blob): Promise<string> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const length = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return toBase64(toWav(rendered.getChannelData(0)));
  } finally {
    await context.close();
  }
}

/** An active capture. `result` settles with base64 WAV after recording stops. */
export interface Recording {
  /** Ends the capture. Safe to call more than once. */
  stop: () => void;
  result: Promise<string>;
}

/**
 * Starts microphone capture with an automatic time limit. The microphone is released when it stops.
 *
 * @throws DOMException when access is denied or no microphone is available.
 */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  const timer = setTimeout(stop, MAX_RECORDING_MS);
  const result = new Promise<string>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      encodeRecording(new Blob(chunks, { type: recorder.mimeType })).then(resolve, reject);
    });
  });
  recorder.start();
  return { stop, result };
}

/** How long to wait for the dictation socket to open before falling back to recording. */
const DICTATION_CONNECT_MS = 6_000;
/** After the visitor stops, how long to wait for the transcriber's final words. */
const DICTATION_SETTLE_MS = 1_500;
/** Audio kept while the socket opens: about 2 seconds of 16 kHz, 16-bit mono. */
const MAX_QUEUED_BYTES = 64_000;

/** A live dictation. Text arrives through `onText` while the visitor speaks. */
export interface Dictation {
  /** Settles once audio is flowing. Rejects when live dictation cannot start, so the caller can fall back. */
  ready: Promise<void>;
  /** The final transcript. Settles when the speaker finishes a turn, on `stop`, or at the time limit. */
  result: Promise<string>;
  /** Ends dictation and keeps the text so far. Safe to call more than once. */
  stop: () => void;
}

/** Optional behaviour for a live dictation. */
export interface DictationOptions {
  /** Receives the microphone level from 0 to 1, a few dozen times a second. */
  onLevel?: (level: number) => void;
  /** End after the first finished turn (the default), or keep listening until Stop or the time limit. */
  endOnTurn?: boolean;
}

/** Worklet URLs already fetched, so each is requested once. */
const preloaded = new Set<string>();

/**
 * Fetches the worklet ahead of the first tap, so `addModule` reads it from the HTTP cache instead
 * of waiting on the network. Failures are ignored: dictation simply fetches it again.
 */
export function preloadDictation(workletUrl: string): void {
  if (preloaded.has(workletUrl) || typeof fetch !== "function") return;
  preloaded.add(workletUrl);
  void fetch(workletUrl, { credentials: "same-origin" }).catch(() => preloaded.delete(workletUrl));
}

/** True when this browser can stream microphone audio through an AudioWorklet. */
export function dictationSupported(): boolean {
  return typeof AudioWorkletNode !== "undefined" && typeof WebSocket !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

/**
 * Starts live dictation. Call it directly from the click handler: the AudioContext is created and
 * resumed before any await, because iOS Safari only lets audio start inside the user's gesture.
 *
 * The microphone, the worklet module and the socket start together. Capture begins as soon as the
 * microphone and worklet are ready, and audio recorded before the socket opens is queued and sent
 * in order, so the first words are not lost while it connects.
 *
 * @param url - The dictation WebSocket URL.
 * @param workletUrl - Where `capture-processor.js` is served.
 * @param onText - Receives the transcript so far, replacing the previous value.
 */
export function startDictation(url: string, workletUrl: string, onText: (text: string) => void, options: DictationOptions = {}): Dictation {
  const context = new AudioContext();
  void context.resume();
  const endOnTurn = options.endOnTurn ?? true;
  let socket: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  /** Finished turns, when dictation continues past the first one. */
  let earlier = "";
  let text = "";
  let finished = false;
  const queue: ArrayBuffer[] = [];
  let queuedBytes = 0;
  /** Stop was pressed while the socket was still opening; finish once the queued audio is sent. */
  let stopRequested = false;
  let settle: (value: string) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const result = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Callers that fall back on `ready` never read `result`; that must not surface as an unhandled rejection.
  result.catch(() => {});

  const cleanUp = () => {
    stream?.getTracks().forEach((track) => track.stop());
    node?.port.postMessage("stop");
    node?.disconnect();
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "Done");
    void context.close().catch(() => {});
  };
  const finish = (value = text) => {
    if (finished) return;
    finished = true;
    cleanUp();
    settle(value.trim());
  };

  /** Sends a chunk, or queues it until the socket opens. The oldest audio is dropped past the cap. */
  const sendAudio = (chunk: ArrayBuffer) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(chunk);
      return;
    }
    queue.push(chunk);
    queuedBytes += chunk.byteLength;
    while (queuedBytes > MAX_QUEUED_BYTES && queue.length > 1) queuedBytes -= queue.shift()?.byteLength ?? 0;
  };

  const ready = (async () => {
    const opened = new WebSocket(url);
    socket = opened;
    opened.binaryType = "arraybuffer";
    let connectError: Error | null = null;
    const connected = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        connectError = new Error(message);
        reject(connectError);
      };
      const timer = setTimeout(() => fail("Dictation did not connect."), DICTATION_CONNECT_MS);
      opened.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      opened.addEventListener("error", () => fail("Dictation did not connect."), { once: true });
      opened.addEventListener("close", () => fail("Dictation was refused."), { once: true });
    });
    // Awaited below; until then a refusal must not surface as an unhandled rejection.
    connected.catch(() => {});

    const [media] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      context.audioWorklet.addModule(workletUrl),
    ]);
    stream = media;
    // Stopped while the permission prompt was open: release the microphone at once.
    if (finished) return cleanUp();
    // Refused before the microphone was ready: no point capturing, so the caller can fall back now.
    if (connectError) throw connectError;

    const source = context.createMediaStreamSource(media);
    node = new AudioWorkletNode(context, "capture-processor");
    node.port.onmessage = (event: MessageEvent<ArrayBuffer | number>) => {
      if (typeof event.data === "number") options.onLevel?.(event.data);
      else sendAudio(event.data);
    };
    source.connect(node);
    // Some browsers only run a worklet that reaches the destination. It outputs silence.
    node.connect(context.destination);
    if (context.state !== "running") await context.resume();

    try {
      await connected;
    } catch (error) {
      // The visitor already pressed Stop: end quietly instead of falling back to recording.
      if (stopRequested) return finish();
      throw error;
    }
    if (finished) return cleanUp();
    opened.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: { event?: string; transcript?: string };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        return;
      }
      if (typeof message.transcript === "string" && message.transcript) {
        text = [earlier, message.transcript].filter(Boolean).join(" ");
        onText(text);
      }
      if (message.event !== "EndOfTurn") return;
      if (endOnTurn) finish();
      else earlier = text.trim();
    });
    // Covers the server's time limit and any drop: keep what was heard.
    opened.addEventListener("close", () => finish());
    for (const chunk of queue.splice(0)) opened.send(chunk);
    queuedBytes = 0;
    if (stopRequested) requestFinalWords();
  })();
  ready.catch((error: unknown) => {
    if (finished) return;
    finished = true;
    cleanUp();
    fail(error);
  });

  /** Asks the transcriber to finish, and keeps whatever arrives in time. */
  function requestFinalWords(): void {
    socket?.send("stop");
    setTimeout(() => finish(), DICTATION_SETTLE_MS);
  }

  const stop = () => {
    if (finished || stopRequested) return;
    const capturing = Boolean(node);
    if (capturing) {
      // Flush the last audio from the worklet and release the microphone.
      node?.port.postMessage("stop");
      stream?.getTracks().forEach((track) => track.stop());
    }
    if (socket?.readyState === WebSocket.OPEN) return requestFinalWords();
    // Still connecting with audio queued: send it once the socket opens, then finish.
    if (capturing && socket?.readyState === WebSocket.CONNECTING) {
      stopRequested = true;
      return;
    }
    finish();
  };
  return { ready, result, stop };
}

/** Plays streamed parts of one answer back to back. */
export interface SpeechPlayer {
  /** Queues one part. Parts must arrive in playback order. */
  add: (base64: string, mimeType: string) => void;
  /** Marks the stream complete, so playback ends after the last queued part. */
  finish: () => void;
  /** Stops at once and frees all audio. No callback runs. */
  stop: () => void;
}

/** Callbacks for a speech player's lifecycle. Each runs at most once. */
export interface SpeechHandlers {
  onStart: () => void;
  onEnd: () => void;
  onError: () => void;
}

/** The one active player. */
let current: SpeechPlayer | null = null;

/** Stops any current playback. Its callbacks do not run. */
export function stopPlayback(): void {
  current?.stop();
  current = null;
}

/**
 * Starts a player for streamed speech, replacing any current playback. Call it directly from the
 * click handler: one audio element is started there with a moment of silence, which counts as the
 * user's gesture on Safari and iOS, and every later part plays through that same element.
 */
export function startSpeech(handlers: SpeechHandlers): SpeechPlayer {
  stopPlayback();
  const audio = new Audio();
  const urls: string[] = [];
  const queue: string[] = [];
  let playing = false;
  let started = false;
  let finished = false;
  let stopped = false;

  const release = () => {
    stopped = true;
    audio.pause();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.length = 0;
    if (current === player) current = null;
  };
  const playNext = () => {
    if (stopped) return;
    const url = queue.shift();
    if (!url) {
      playing = false;
      if (finished) {
        release();
        handlers.onEnd();
      }
      return;
    }
    playing = true;
    audio.src = url;
    audio.play().then(
      () => {
        if (!started && !stopped) {
          started = true;
          handlers.onStart();
        }
      },
      () => {
        if (stopped) return;
        release();
        handlers.onError();
      },
    );
  };
  audio.addEventListener("ended", () => {
    if (playing) playNext();
  });

  // A short silent clip, started inside the gesture, unlocks this element for later parts.
  const silence = URL.createObjectURL(new Blob([toWav(new Float32Array(TARGET_SAMPLE_RATE / 20))], { type: "audio/wav" }));
  urls.push(silence);
  audio.src = silence;
  audio.play().catch(() => {});

  const player: SpeechPlayer = {
    add(base64, mimeType) {
      if (stopped) return;
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      urls.push(url);
      queue.push(url);
      if (!playing) playNext();
    },
    finish() {
      finished = true;
      if (!playing && !stopped) playNext();
    },
    stop: release,
  };
  current = player;
  return player;
}
