/*
 * Pure helpers for voice features: validating uploaded WAV data and preparing stored text for
 * speech. `CodexGuardAgent` calls these before `speech.ts` reaches a model.
 */
import { Buffer } from "node:buffer";
import { normalizeText } from "./input";
import { redactSecrets } from "./rules";
import { MAX_AUDIO_BYTES } from "./schemas";
import type { RuleResult } from "./types";

/** Longest text sent to text-to-speech, which bounds the cost of one request. */
export const MAX_SPOKEN_CHARS = 1_500;

/** Decoded audio bytes, or a message that can be shown to the user. */
export type DecodedAudio = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/**
 * Decodes schema-checked base64 and accepts only the format the browser client produces: 16 kHz,
 * 16-bit, mono PCM with a canonical header. Fixing the rate makes the byte cap a duration cap.
 */
export function decodeWav(base64: string): DecodedAudio {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, error: "That recording is too long. Keep it under 30 seconds." };
  const invalid: DecodedAudio = { ok: false, error: "The audio must be a 16 kHz mono WAV recording." };
  if (bytes.length <= 44) return invalid;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const valid =
    ascii(0, 4) === "RIFF" &&
    ascii(8, 16) === "WAVEfmt " &&
    ascii(36, 40) === "data" &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16_000 &&
    view.getUint16(34, true) === 16 &&
    view.getUint32(40, true) === bytes.length - 44;
  return valid ? { ok: true, bytes } : invalid;
}

/** Shortens text to `MAX_SPOKEN_CHARS`, ending at the last full sentence when one exists. */
function fitToLimit(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const cut = text.slice(0, MAX_SPOKEN_CHARS);
  const sentenceEnd = cut.lastIndexOf(". ");
  return sentenceEnd > 0 ? cut.slice(0, sentenceEnd + 1) : cut;
}

/**
 * Turns stored markdown-like text into plain text that reads well aloud.
 *
 * Code blocks are replaced with a short notice. The result is normalized, redacted and length-limited.
 */
export function toSpokenText(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " Code example omitted. ");
  const plain = withoutCode
    .split("\n")
    .map((line) => line.replace(/^###\s*(F\d+)\s*·\s*(\S+)/, "Finding $1, standard $2.").replace(/[*`#]/g, "").trim())
    .filter(Boolean)
    .join(" ");
  return fitToLimit(redactSecrets(normalizeText(plain)));
}

/** The verdict is spoken from rule results, so the model cannot restate it. */
export function buildSpokenReview(result: RuleResult, commentary: string): string {
  const open = result.findings.filter((finding) => finding.status === "open").length;
  const verdict = `Rule engine result: ${result.risk} risk, with ${open} open finding${open === 1 ? "" : "s"}.`;
  const explanation = toSpokenText(commentary);
  return fitToLimit(explanation ? `${verdict} AI commentary follows. ${explanation}` : verdict);
}
