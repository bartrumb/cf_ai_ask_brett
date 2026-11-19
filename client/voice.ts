/*
 * Browser audio helpers: microphone capture, conversion to the WAV format the server accepts, and
 * playback of returned speech. `main.ts` owns the related UI state.
 */
/** Output sample rate. With 30 seconds of 16-bit mono it stays within `MAX_AUDIO_BYTES`. */
const TARGET_SAMPLE_RATE = 16_000;
/** Recording stops automatically after this long. */
export const MAX_RECORDING_MS = 30_000;

/** Encodes mono samples as a 16-bit PCM WAV file, clipping values outside the valid range. */
function toWav(samples: Float32Array): Uint8Array {
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

/** The one active playback and the object URL to release. */
let current: { audio: HTMLAudioElement; url: string } | null = null;

/** Stops playback and frees its URL. The `onEnd` callback is not called. */
export function stopPlayback(): void {
  if (!current) return;
  current.audio.pause();
  URL.revokeObjectURL(current.url);
  current = null;
}

/**
 * Replaces any current playback with the given audio.
 *
 * @param base64 - Encoded audio from the server.
 * @param mimeType - Audio type of the decoded bytes.
 * @param onEnd - Called when playback reaches its end.
 * @throws An error when decoding fails or the browser refuses to start playback.
 */
export async function playAudio(base64: string, mimeType: string, onEnd: () => void): Promise<void> {
  stopPlayback();
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const audio = new Audio(url);
  current = { audio, url };
  audio.addEventListener("ended", () => {
    if (current?.audio === audio) stopPlayback();
    onEnd();
  });
  await audio.play();
}
