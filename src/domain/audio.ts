import { Buffer } from "node:buffer";
import { normalizeText } from "./input";
import { redactSecrets } from "./rules";
import { MAX_AUDIO_BYTES } from "./schemas";
import type { RuleResult } from "./types";

export const MAX_SPOKEN_CHARS = 1_500;

export type DecodedAudio = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/** Decodes schema-checked base64 and confirms that it is a bounded WAV file. */
export function decodeWav(base64: string): DecodedAudio {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, error: "That recording is too long. Keep it under 30 seconds." };
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length <= 44 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") {
    return { ok: false, error: "The audio must be a WAV recording." };
  }
  return { ok: true, bytes };
}

function fitToLimit(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const cut = text.slice(0, MAX_SPOKEN_CHARS);
  const sentenceEnd = cut.lastIndexOf(". ");
  return sentenceEnd > 0 ? cut.slice(0, sentenceEnd + 1) : cut;
}

/** Turns stored markdown-like text into plain text that reads well aloud. */
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
