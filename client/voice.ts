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

/** A live dictation. Text arrives through `onText` while the visitor speaks. */
export interface Dictation {
  /** Settles once audio is flowing. Rejects when live dictation cannot start, so the caller can fall back. */
  ready: Promise<void>;
  /** The final transcript. Settles when the speaker finishes a turn, on `stop`, or at the time limit. */
  result: Promise<string>;
  /** Ends dictation and keeps the text so far. Safe to call more than once. */
  stop: () => void;
}

/** True when this browser can stream microphone audio through an AudioWorklet. */
export function dictationSupported(): boolean {
  return typeof AudioWorkletNode !== "undefined" && typeof WebSocket !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

/**
 * Starts live dictation. Call it directly from the click handler: the AudioContext is created and
 * resumed before any await, because iOS Safari only lets audio start inside the user's gesture.
 *
 * @param url - The dictation WebSocket URL.
 * @param workletUrl - Where `capture-processor.js` is served.
 * @param onText - Receives the transcript so far, replacing the previous value.
 */
export function startDictation(url: string, workletUrl: string, onText: (text: string) => void): Dictation {
  const context = new AudioContext();
  void context.resume();
  let socket: WebSocket | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let text = "";
  let finished = false;
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

  const ready = (async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // Stopped while the permission prompt was open: release the microphone at once.
    if (finished) return cleanUp();
    await context.audioWorklet.addModule(workletUrl);
    const opened = new WebSocket(url);
    socket = opened;
    opened.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Dictation did not connect.")), DICTATION_CONNECT_MS);
      opened.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      opened.addEventListener("error", () => (clearTimeout(timer), reject(new Error("Dictation did not connect."))), { once: true });
      opened.addEventListener("close", () => (clearTimeout(timer), reject(new Error("Dictation was refused."))), { once: true });
    });
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
        text = message.transcript;
        onText(text);
      }
      if (message.event === "EndOfTurn") finish();
    });
    // Covers the server's time limit and any drop: keep what was heard.
    opened.addEventListener("close", () => finish());
    const source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "capture-processor");
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (opened.readyState === WebSocket.OPEN) opened.send(event.data);
    };
    source.connect(node);
    // Some browsers only run a worklet that reaches the destination. It outputs silence.
    node.connect(context.destination);
    if (context.state !== "running") await context.resume();
  })();
  ready.catch((error: unknown) => {
    if (finished) return;
    finished = true;
    cleanUp();
    fail(error);
  });

  const stop = () => {
    if (finished) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return finish();
    // Flush the last audio, ask the transcriber to finish, and keep whatever arrives in time.
    node?.port.postMessage("stop");
    stream?.getTracks().forEach((track) => track.stop());
    socket.send("stop");
    setTimeout(() => finish(), DICTATION_SETTLE_MS);
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
