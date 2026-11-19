import { Buffer } from "node:buffer";
import type { CommentarySource } from "./domain/types";
import { gatewayOptions, type GatewayContext } from "./gateway";
import { isOffline } from "./llm";
import { MODELS } from "./models";

export const OFFLINE_TRANSCRIPT = "Drop the legacy orders table and skip the integration tests in CI.";

type SpeechEnv = Pick<Env, "AI" | "AI_MODE" | "AI_GATEWAY_ID">;
type Source = Exclude<CommentarySource, "unavailable">;
type RunModel = (model: string, input: unknown, options: unknown) => Promise<unknown>;

export interface Transcript {
  text: string;
  source: Source;
  model: string | null;
}

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

function readNovaTranscript(output: unknown): string {
  const result = output as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } };
  const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") throw new Error("Unexpected transcription response.");
  return transcript.trim();
}

function readWhisperTranscript(output: unknown): string {
  const text = (output as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("Unexpected transcription response.");
  return text.trim();
}

export async function transcribeAudio(env: SpeechEnv, wav: Uint8Array, context: GatewayContext): Promise<Transcript> {
  if (isOffline(env)) return { text: OFFLINE_TRANSCRIPT, source: "offline", model: null };

  const run = runner(env);
  // Recordings are not needed to monitor spend, so ask the gateway not to log them.
  const options = {
    gateway: gatewayOptions(env, context),
    extraHeaders: { "cf-aig-collect-log-payload": "false" },
  };
  try {
    const output = await run(
      MODELS.stt.primary,
      { audio: { body: new Response(wav).body, contentType: "audio/wav" }, smart_format: true, punctuate: true },
      options,
    );
    return { text: readNovaTranscript(output), source: "workers-ai", model: MODELS.stt.primary };
  } catch (error) {
    console.warn("primary transcription failed", error instanceof Error ? error.message : "unknown error");
  }
  const output = await run(
    MODELS.stt.secondary,
    { audio: Buffer.from(wav).toString("base64"), task: "transcribe", language: "en", vad_filter: true },
    options,
  );
  return { text: readWhisperTranscript(output), source: "workers-ai", model: MODELS.stt.secondary };
}

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

export async function synthesizeSpeech(env: SpeechEnv, text: string, context: GatewayContext): Promise<SpokenAudio> {
  if (isOffline(env)) return { audio: offlineTone(), mimeType: "audio/wav", source: "offline", model: null };

  const run = runner(env);
  const options = { gateway: gatewayOptions(env, context), returnRawResponse: true };
  const input = { text, speaker: "luna", encoding: "mp3" };
  const speak = async (model: string): Promise<SpokenAudio> => ({
    audio: await readAudioResponse(await run(model, input, options)),
    mimeType: "audio/mpeg",
    source: "workers-ai",
    model,
  });
  try {
    return await speak(MODELS.tts.primary);
  } catch (error) {
    console.warn("primary speech failed", error instanceof Error ? error.message : "unknown error");
  }
  return speak(MODELS.tts.secondary);
}
