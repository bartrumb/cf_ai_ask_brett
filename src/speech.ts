/*
 * Speech-to-text and text-to-speech calls, each with a fallback model and an offline path. Calls go
 * through AI Gateway, except text to speech when an ElevenLabs or Deepgram key is set.
 * `ShowcaseAgent` handles validation, rate limits and redaction around these calls.
 */
import { Buffer } from "node:buffer";
import type { AnswerSource, SpokenPart } from "./domain/types";
import { gatewayMetadata, gatewayOptions, type GatewayContext } from "./gateway";
import { isOffline } from "./llm";
import { ELEVENLABS_VOICE, MODELS, TTS_SPEAKERS } from "./models";

/** ElevenLabs' speech endpoint for the podcast voice. 64 kbps keeps long answers small to send. */
const ELEVENLABS_SPEAK_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE.id}?output_format=mp3_44100_64`;

/** Deepgram's speech endpoint, set to the podcast's backup voice. */
const DEEPGRAM_SPEAK_URL = `https://api.deepgram.com/v1/speak?model=${MODELS.tts.deepgram}&encoding=mp3`;

/** Fixed transcript returned in offline mode, so the voice flow can be tried for free. */
export const OFFLINE_TRANSCRIPT = "What is the strongest proof of this work?";

/** Time allowed for most speech models on one part. */
const SPEECH_TIMEOUT_MS = 12_000;
/** Time allowed for ElevenLabs on one part, before the fallback is tried. */
const ELEVENLABS_TIMEOUT_MS = 15_000;

/** Bindings needed for speech calls. */
type SpeechEnv = Pick<Env, "AI" | "AI_MODE" | "AI_GATEWAY_ID"> & {
  AI_GATEWAY_TOKEN?: string;
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
};
/** Where a successful speech result came from. */
type Source = Extract<AnswerSource, "workers-ai" | "offline">;
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
  source: Source | "deepgram" | "elevenlabs";
  model: string | null;
}

export type { SpokenPart };

/** Surrounding text, which helps ElevenLabs keep its delivery consistent across parts. */
export interface SpeechNeighbors {
  previous?: string;
  next?: string;
}

/** The first part is one sentence, so playback can start after a short request. */
const FIRST_PART_MAX_CHARS = 200;
/** Later parts group sentences up to this length. */
const PART_MAX_CHARS = 320;
/** Parts generated at once. ElevenLabs plans allow a few concurrent requests. */
const PARALLEL_PARTS = 3;

/** Splits an over-long sentence into word-aligned pieces. */
function splitWords(sentence: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (current && current.length + 1 + word.length > limit) {
      pieces.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Splits text into parts for streamed speech: a short first part so audio starts quickly, then
 * sentence groups that keep natural pauses at part boundaries.
 */
export function splitForSpeech(text: string): string[] {
  const sentences = (text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const limit = parts.length === 0 && !current ? FIRST_PART_MAX_CHARS : PART_MAX_CHARS;
    for (const piece of sentence.length > limit ? splitWords(sentence, limit) : [sentence]) {
      if (parts.length === 0 && !current) {
        parts.push(piece);
      } else if (current && current.length + 1 + piece.length > PART_MAX_CHARS) {
        parts.push(current);
        current = piece;
      } else current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Speaks text as a stream of parts. Up to `PARALLEL_PARTS` are generated at once, and each is
 * emitted in order as soon as it and every earlier part are ready.
 *
 * @param emit - Receives each part in playback order.
 * @returns The number of parts emitted.
 * @throws The first part's error when no audio could be produced at all.
 */
export async function streamSpeech(env: SpeechEnv, text: string, context: GatewayContext, emit: (part: SpokenPart) => void): Promise<number> {
  const parts = splitForSpeech(text);
  const pending: Promise<SpokenAudio>[] = [];
  const start = (index: number) => {
    const request = synthesizeSpeech(env, parts[index] ?? "", context, undefined, { previous: parts[index - 1], next: parts[index + 1] });
    // A later failure is handled when its turn comes, or ignored once the stream has stopped.
    request.catch(() => {});
    pending[index] = request;
  };
  let started = 0;
  for (; started < Math.min(PARALLEL_PARTS, parts.length); started += 1) start(started);
  let emitted = 0;
  for (let index = 0; index < parts.length; index += 1) {
    let audio: SpokenAudio;
    try {
      audio = await (pending[index] as Promise<SpokenAudio>);
    } catch (error) {
      // Stopping here avoids a gap in the middle of an answer.
      if (emitted === 0) throw error;
      console.warn("speech part failed", error instanceof Error ? error.message : "unknown error");
      break;
    }
    if (started < parts.length) start(started++);
    emit({ index, ...audio });
    emitted += 1;
  }
  return emitted;
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
 * Requests speech from ElevenLabs' own API. Redirects are not followed, so the key is only ever sent
 * to ElevenLabs, and a redirect counts as a failure.
 */
function requestElevenLabsSpeech(apiKey: string, text: string, signal: AbortSignal, neighbors: SpeechNeighbors = {}): Promise<Response> {
  return fetch(ELEVENLABS_SPEAK_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODELS.tts.elevenLabs,
      voice_settings: ELEVENLABS_VOICE.settings,
      ...(neighbors.previous ? { previous_text: neighbors.previous } : {}),
      ...(neighbors.next ? { next_text: neighbors.next } : {}),
    }),
    redirect: "manual",
    signal,
  });
}

/**
 * Requests speech from Deepgram's own API. Redirects are not followed, so the key is only ever sent
 * to Deepgram, and a redirect counts as a failure.
 */
function requestDeepgramSpeech(apiKey: string, text: string, signal: AbortSignal): Promise<Response> {
  return fetch(DEEPGRAM_SPEAK_URL, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    redirect: "manual",
    signal,
  });
}

/**
 * Synthesizes MP3 speech in at most two attempts, so both fit inside the browser's call limit. The
 * order of preference is ElevenLabs, Deepgram, then Aura-1 through the gateway, skipping a vendor
 * with no key. With no vendor key, Aura-2 through the gateway goes first.
 *
 * @param text - Text already prepared and length-limited by `domain/audio.ts`.
 * @param context - Gateway metadata for the request.
 * @param timeoutMs - Overrides the time allowed for every attempt.
 * @param neighbors - Text before and after this part, for consistent delivery.
 * @throws The fallback model's error when both attempts fail.
 */
export async function synthesizeSpeech(
  env: SpeechEnv,
  text: string,
  context: GatewayContext,
  timeoutMs?: number,
  neighbors: SpeechNeighbors = {},
): Promise<SpokenAudio> {
  if (isOffline(env)) return { audio: offlineTone(), mimeType: "audio/wav", source: "offline", model: null };

  const run = runner(env);
  const options = { gateway: gatewayOptions(env, context), returnRawResponse: true };
  // The limit covers the whole download, because a slow stream can start promptly and then stall.
  const readWithin = async (request: (signal: AbortSignal) => Promise<unknown>, limitMs = timeoutMs ?? SPEECH_TIMEOUT_MS): Promise<string> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Speech request timed out."));
      }, limitMs);
    });
    try {
      const audio = (async () => readAudioResponse(await request(controller.signal)))();
      return await Promise.race([audio, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const speakThroughGateway = async (model: string, speaker: string): Promise<SpokenAudio> => {
    const input = { text, speaker, encoding: "mp3" };
    const audio = await readWithin((signal) => run(model, input, { ...options, signal }));
    return { audio, mimeType: "audio/mpeg", source: "workers-ai", model };
  };
  const attempts: (() => Promise<SpokenAudio>)[] = [];
  const { ELEVENLABS_API_KEY: elevenLabsKey, DEEPGRAM_API_KEY: deepgramKey } = env;
  if (elevenLabsKey) {
    attempts.push(async () => ({
      audio: await readWithin((signal) => requestElevenLabsSpeech(elevenLabsKey, text, signal, neighbors), timeoutMs ?? ELEVENLABS_TIMEOUT_MS),
      mimeType: "audio/mpeg",
      source: "elevenlabs",
      model: MODELS.tts.elevenLabs,
    }));
  }
  if (deepgramKey) {
    attempts.push(async () => ({
      audio: await readWithin((signal) => requestDeepgramSpeech(deepgramKey, text, signal)),
      mimeType: "audio/mpeg",
      source: "deepgram",
      model: MODELS.tts.deepgram,
    }));
  }
  if (attempts.length === 0) attempts.push(() => speakThroughGateway(MODELS.tts.primary, TTS_SPEAKERS.primary));
  attempts.push(() => speakThroughGateway(MODELS.tts.secondary, TTS_SPEAKERS.secondary));

  const [first, second] = attempts as [() => Promise<SpokenAudio>, () => Promise<SpokenAudio>];
  try {
    return await first();
  } catch (error) {
    console.warn("primary speech failed", error instanceof Error ? error.message : "unknown error");
  }
  return second();
}
