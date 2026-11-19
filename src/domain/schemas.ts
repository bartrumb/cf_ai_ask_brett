/*
 * Zod schemas for everything that crosses a trust boundary: browser RPC arguments, WebSocket frames,
 * repository names and Workflow params. Validation messages are written to be shown to users.
 */
import { z } from "zod";
import {
  MAX_INPUT_CHARS,
  MAX_INPUT_LINES,
  MAX_LINE_CHARS,
  MAX_QUESTION_CHARS,
  MAX_REASON_CHARS,
  MIN_REASON_CHARS,
  normalizeText,
} from "./input";
import { SAMPLE_STANDARDS } from "./standards";

/** Largest WAV upload. 30 seconds of 16 kHz, 16-bit mono audio is about 960 KB. */
export const MAX_AUDIO_BYTES = 1_000_000;
/** Base64 length of the largest upload, with room for padding. */
const MAX_AUDIO_BASE64_CHARS = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4;
/** Largest accepted frame: the largest audio payload plus its JSON envelope. */
const MAX_CLIENT_FRAME_CHARS = MAX_AUDIO_BASE64_CHARS + 1_000;
// eslint-disable-next-line no-control-regex
/** Control characters other than tab, newline and carriage return. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Validated data, or the first validation message. */
export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Validates untrusted input without throwing and reports only the first issue. */
export function parseInput<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.issues[0]?.message ?? "The request is not valid." };
}

/** Formats a number for validation messages. */
const count = (value: number) => value.toLocaleString("en-US");

/**
 * Builds a required text schema with a character limit. Line endings are normalized first, so limits
 * and later parsing see the same text.
 *
 * @param label - Subject used in error messages.
 */
function boundedText(label: string, maxChars: number) {
  return z
    .string({ error: `${label} must be text.` })
    .transform((text) => text.replace(/\r\n?/g, "\n"))
    .superRefine((text, context) => {
      let message: string | undefined;
      if (text.trim().length === 0) message = `${label} is empty.`;
      else if (text.length > maxChars) {
        message = `${label} is ${count(text.length)} characters. The limit is ${count(maxChars)}. Split it into smaller parts.`;
      } else if (FORBIDDEN_CONTROL.test(text)) message = `${label} contains binary or control characters.`;
      if (message) context.addIssue({ code: "custom", message });
    });
}

/**
 * Oversized input is rejected, never truncated: truncation could hide a risky
 * line from the rules. The per-line cap also bounds regular-expression work.
 */
export const changeTextSchema = boundedText("The change", MAX_INPUT_CHARS).superRefine((text, context) => {
  const lines = text.split("\n");
  if (lines.length > MAX_INPUT_LINES) {
    context.addIssue({ code: "custom", message: `The change has ${count(lines.length)} lines. The limit is ${count(MAX_INPUT_LINES)}.` });
  } else if (lines.some((line) => line.length > MAX_LINE_CHARS)) {
    context.addIssue({ code: "custom", message: `A line is longer than ${count(MAX_LINE_CHARS)} characters. Remove generated or minified content.` });
  }
});

/** Follow-up question text. */
export const questionTextSchema = boundedText("The question", MAX_QUESTION_CHARS);

/** Exception reason. The minimum applies after normalization, so hidden characters do not count. */
export const reasonSchema = boundedText("The reason", MAX_REASON_CHARS)
  .transform((text) => normalizeText(text).trim())
  .refine((text) => text.length >= MIN_REASON_CHARS, {
    error: `Give a reason of at least ${MIN_REASON_CHARS} characters.`,
  });

/** Client-generated idempotency key. */
const requestIdSchema = z.uuid({ error: "The request ID is not valid." });
/** Server-generated record ID. Failures read as not found. */
const recordIdSchema = z.uuid({ error: "That item was not found." });
/** Known standard IDs, as the non-empty tuple `z.enum` expects. */
const standardIds = SAMPLE_STANDARDS.map((standard) => standard.id) as [string, ...string[]];

/** Arguments to `startReview`. Strict objects reject unknown fields. */
export const reviewRequestSchema = z.strictObject({ text: changeTextSchema, requestId: requestIdSchema });
/** Arguments to `ask`. */
export const questionRequestSchema = z.strictObject({ question: questionTextSchema, requestId: requestIdSchema });
/** Arguments to `acceptException`. Finding IDs have the form `F1` to `F999`. */
export const acceptExceptionSchema = z.strictObject({
  reviewId: recordIdSchema,
  findingId: z.string().regex(/^F[1-9]\d{0,2}$/, { error: "That finding was not found." }),
  reason: reasonSchema,
});
/** Arguments to `revokeException`. */
export const revokeExceptionSchema = z.strictObject({ id: recordIdSchema });
/** Arguments to `setStandardEnabled`. */
export const setStandardSchema = z.strictObject({
  id: z.enum(standardIds, { error: "That standard was not found." }),
  enabled: z.boolean({ error: "Enabled must be true or false." }),
});
/** Arguments to `transcribe`. Size and alphabet are checked before any decoding. */
export const transcribeSchema = z.strictObject({
  audio: z
    .string({ error: "No audio was received." })
    .min(1, { error: "No audio was received." })
    .max(MAX_AUDIO_BASE64_CHARS, { error: "That recording is too long. Keep it under 30 seconds." })
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, { error: "The audio could not be read." }),
});
/** Arguments to `speak`: a review UUID or a numeric chat message ID. */
export const speakRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("review"), id: recordIdSchema }),
    z.strictObject({ kind: z.literal("message"), id: z.number().int().positive() }),
  ],
  { error: "There is nothing to read aloud yet." },
);
/** Workflow params, after `AgentWorkflow` removes the routing fields it adds at launch. */
export const reviewParamsSchema = z.strictObject({ reviewId: z.uuid(), repository: z.string().min(1).max(64) });
/** Repository name, which is also the Durable Object name. `toSlug` in the client must match. */
export const repositoryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/** The only agent methods a browser may call. Inherited SDK methods stay private. */
export const CLIENT_METHODS = [
  "getSnapshot",
  "startReview",
  "acceptException",
  "revokeException",
  "setStandardEnabled",
  "ask",
  "transcribe",
  "speak",
] as const;

/** The RPC frame shape. Every client method takes at most one argument. */
const clientFrameSchema = z.strictObject({
  type: z.literal("rpc"),
  id: z.string().min(1).max(100),
  method: z.enum(CLIENT_METHODS),
  args: z.array(z.unknown()).max(1),
});

/**
 * Think also accepts chat, tool-result, clear and state frames on this socket.
 * Allowing only named RPC calls keeps validation and rate limits unavoidable.
 */
export function isAllowedClientFrame(message: unknown): boolean {
  if (typeof message !== "string" || message.length > MAX_CLIENT_FRAME_CHARS) return false;
  try {
    return clientFrameSchema.safeParse(JSON.parse(message)).success;
  } catch {
    return false;
  }
}
