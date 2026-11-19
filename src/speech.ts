/*
 * Speech-to-text and text-to-speech calls, each with a fallback model and an offline path. Calls go
 * through AI Gateway, except text to speech when a Deepgram key is set. `ShowcaseAgent` handles
 * validation, rate limits and redaction around these calls.
 */
import { Buffer } from "node:buffer";
import type { AnswerSource } from "./domain/types";
import { gatewayMetadata, gatewayOptions, type GatewayContext } from "./gateway";
import { isOffline } from "./llm";
import { MODELS, TTS_SPEAKERS } from "./models";

/** Deepgram's speech endpoint, set to the podcast voice. */
const DEEPGRAM_SPEAK_URL = `https://api.deepgram.com/v1/speak?model=${MODELS.tts.direct}&encoding=mp3`;

/** Fixed transcript returned in offline mode, so the voice flow can be tried for free. */
export const OFFLINE_TRANSCRIPT = "What is the strongest proof of this work?";

/** Time allowed for each speech model, so both attempts fit inside the browser's 30-second call limit. */
const SPEECH_TIMEOUT_MS = 12_000;

/** Bindings needed for speech calls. */
type SpeechEnv = Pick<Env, "AI" | "AI_MODE" | "AI_GATEWAY_ID"> & { AI_GATEWAY_TOKEN?: string; DEEPGRAM_API_KEY?: string };
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
  source: Source | "deepgram";
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
 * Synthesizes MP3 speech in two attempts, so both fit inside the browser's call limit. The first is
 * Deepgram directly when `DEEPGRAM_API_KEY` is set, otherwise Aura-2 through the gateway. The second
 * is always Aura-1 through the gateway, which keeps speech working if Deepgram's API is unavailable.
 *
 * @param text - Text already prepared and length-limited by `domain/audio.ts`.
 * @param context - Gateway metadata for the request.
 * @throws The fallback model's error when both attempts fail.
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
  // The limit covers the whole download, because a slow stream can start promptly and then stall.
  const readWithin = async (request: (signal: AbortSignal) => Promise<unknown>): Promise<string> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Speech request timed out."));
      }, timeoutMs);
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
  const speakFirstChoice = async (): Promise<SpokenAudio> => {
    const apiKey = env.DEEPGRAM_API_KEY;
    if (!apiKey) return speakThroughGateway(MODELS.tts.primary, TTS_SPEAKERS.primary);
    const audio = await readWithin((signal) => requestDeepgramSpeech(apiKey, text, signal));
    return { audio, mimeType: "audio/mpeg", source: "deepgram", model: MODELS.tts.direct };
  };
  try {
    return await speakFirstChoice();
  } catch (error) {
    console.warn("primary speech failed", error instanceof Error ? error.message : "unknown error");
  }
  return speakThroughGateway(MODELS.tts.secondary, TTS_SPEAKERS.secondary);
}
