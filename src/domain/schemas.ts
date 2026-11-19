/*
 * Zod schemas for everything that crosses a trust boundary: browser RPC arguments, WebSocket frames
 * and conversation IDs. Validation messages are written to be shown to visitors.
 */
import { z } from "zod";
import { normalizeText } from "./redaction";

/** Longest accepted question, in characters. */
export const MAX_QUESTION_CHARS = 500;
/** Largest WAV upload. 30 seconds of 16 kHz, 16-bit mono audio is about 960 KB. */
export const MAX_AUDIO_BYTES = 1_000_000;
/** Base64 length of the largest upload, with room for padding. */
const MAX_AUDIO_BASE64_CHARS = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4;
/** Largest accepted frame: the largest audio payload plus its JSON envelope. */
const MAX_CLIENT_FRAME_CHARS = MAX_AUDIO_BASE64_CHARS + 1_000;
/** Control characters other than tab, newline and carriage return. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Validated data, or the first validation message. */
export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Validates untrusted input without throwing and reports only the first issue. */
export function parseInput<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.issues[0]?.message ?? "The request is not valid." };
}

/** Question text. The limit also applies after normalization, which can lengthen text. */
export const questionTextSchema = z
  .string({ error: "The question must be text." })
  .transform((text) => text.replace(/\r\n?/g, "\n"))
  .superRefine((text, context) => {
    let message: string | undefined;
    if (normalizeText(text).trim().length === 0) message = "Type a question first.";
    else if (text.length > MAX_QUESTION_CHARS || normalizeText(text).length > MAX_QUESTION_CHARS) {
      message = `Questions can be up to ${MAX_QUESTION_CHARS} characters.`;
    } else if (FORBIDDEN_CONTROL.test(text)) message = "The question contains unsupported characters.";
    if (message) context.addIssue({ code: "custom", message });
  });

/** Arguments to `ask`. Strict objects reject unknown fields. */
export const questionRequestSchema = z.strictObject({
  question: questionTextSchema,
  requestId: z.uuid({ error: "The request ID is not valid." }),
});
/** Arguments to `transcribe`. Size and alphabet are checked before any decoding. */
export const transcribeSchema = z.strictObject({
  audio: z
    .string({ error: "No audio was received." })
    .min(1, { error: "No audio was received." })
    .max(MAX_AUDIO_BASE64_CHARS, { error: "That recording is too long. Keep it under 30 seconds." })
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, { error: "The audio could not be read." }),
});
/** Arguments to `speak`. Only a stored answer can be read aloud, never supplied text. */
export const speakRequestSchema = z.strictObject({
  messageId: z.number({ error: "There is nothing to read aloud yet." }).int().positive(),
});
/** Conversation ID, which is also the Durable Object name: 128 random bits in hex. */
export const conversationIdSchema = z.string().regex(/^[a-f0-9]{32}$/);

/** The only agent methods a browser may call. Inherited SDK methods stay private. */
export const CLIENT_METHODS = ["getSnapshot", "ask", "transcribe", "speak"] as const;

/** The RPC frame shape. Every client method takes at most one argument. */
const clientFrameSchema = z.strictObject({
  type: z.literal("rpc"),
  id: z.string().min(1).max(100),
  method: z.enum(CLIENT_METHODS),
  args: z.array(z.unknown()).max(1),
});

/**
 * Think also accepts chat, tool-result, clear and state frames on this socket. Returning an ID only
 * for named RPC calls keeps validation and rate limits unavoidable.
 *
 * @returns The RPC ID of an allowed frame, or null for anything else.
 */
export function allowedClientFrameId(message: unknown): string | null {
  if (typeof message !== "string" || message.length > MAX_CLIENT_FRAME_CHARS) return null;
  try {
    const frame = clientFrameSchema.safeParse(JSON.parse(message));
    return frame.success ? frame.data.id : null;
  } catch {
    return null;
  }
}
