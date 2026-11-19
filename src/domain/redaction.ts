/*
 * Text hygiene shared by storage, prompts, live streaming and speech: Unicode normalization, secret
 * masking, and the output filter that keeps money figures and phone numbers out of answers.
 */
import { scrubKnowledge } from "./content";

/** Soft hyphen, zero-width and bidirectional control characters, and the byte order mark. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Removes characters that can hide text from people and from pattern matching.
 * NFKC also folds compatibility forms such as full-width letters into their plain equivalents.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

/** Credential-like names. Common non-secret forms such as `token_count` are excluded. */
const SECRET_WORD = String.raw`(?:api[_-]?key|auth[_-]?key|private[_-]?key|secret|token(?!iz|s\b|[_-](?:count|type|limit|url|endpoint))|(?<![a-z])pass(?:word|wd|phrase)?|passw(?:or)?d|credential)`;
/** A credential-like name followed by an assignment operator. Quantifiers are bounded. */
const SECRET_NAME = String.raw`\b[\w-]{0,40}${SECRET_WORD}[\w-]{0,40}["']?\s{0,5}(?::=|=>|[:=])\s{0,5}`;
/** A quoted value, excluding template placeholders. */
const QUOTED_SECRET = String.raw`(["'])(?!\$\{|\{\{|<)(?:(?!\2).){8,400}?\2`;
/** End of an unquoted value. */
const VALUE_END = String.raw`(?=$|[\s,;])`;
/** Unquoted forms that are references to values: variables, properties, calls and numbers. */
const CODE_VALUE = String.raw`\$[A-Za-z_{]|\{\{|<|arn:|\d+${VALUE_END}|[A-Za-z_$][\w$]*(?:\.[\w$]+)+${VALUE_END}|[\w$.]+\([^\s]{0,100}\)${VALUE_END}`;
/** An unquoted value with a digit or symbol, or a long lowercase passphrase. */
const UNQUOTED_SECRET = String.raw`(?!${CODE_VALUE})(?:(?=[^\s"',;]{0,200}[\d!@#%^&*+/=~$-])[^\s"',;]{8,200}|[a-z]{16,200})${VALUE_END}`;
/** Named assignments. Group 1 is the name and operator, and group 2 is any opening quote. */
const SECRET_ASSIGNMENT = String.raw`(${SECRET_NAME})(?:${QUOTED_SECRET}|${UNQUOTED_SECRET})`;
/** Credentials recognizable by format alone. */
const SECRET_TOKENS = [
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{30,60}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,255}\b`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,255}\b`,
  String.raw`\bglpat-[\w-]{16,100}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,100}\b`,
  String.raw`\bsk-[A-Za-z0-9_-]{16,255}\b`,
  String.raw`\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,255}\b`,
  String.raw`\bxox[abeoprs]-[A-Za-z0-9-]{10,255}\b`,
  String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,200}`,
  String.raw`\beyJ[\w-]{8,1000}\.eyJ[\w-]{8,1000}\.[\w-]{8,1000}`,
];
/** An HTTP bearer credential. */
const BEARER_TOKEN = String.raw`\bBearer\s{1,5}[A-Za-z0-9._~+/-]{20,1000}`;
/** An authorization header value. Group 1 keeps the header name and scheme. */
const AUTH_HEADER = String.raw`(\bauthorization["']?\s{0,5}[:=]\s{0,5}["']?(?:bearer|basic)\s{1,5})[^\s"']{8,1000}`;
/** A password in a URL. Group 1 is the scheme and user, and group 2 precedes the host. */
const URL_CREDENTIAL = String.raw`(\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@]{1,100}:)(?!\d{1,5}(?:/|@))[^\s@]{1,200}(@)`;
/** Mixed-case base64-like text. It is masked but not reported, because hashes also match. */
const OPAQUE_VALUE = String.raw`\b(?=[A-Za-z0-9+/]{0,200}\d)(?=[A-Za-z0-9+/]{0,200}[A-Z])(?=[A-Za-z0-9+/]{0,200}[a-z])[A-Za-z0-9+/]{40,1000}={0,2}`;
/** Replacement shown for every part of a private key. */
const PRIVATE_KEY_MASK = "[REDACTED PRIVATE KEY]";

/**
 * Masks credential-like values before text is stored, displayed or sent to a model. It uses the
 * same pattern sources as detection. A private key is masked from its BEGIN marker through its END
 * marker when both are in the supplied text.
 */
export function redactSecrets(text: string): string {
  let redacted = text.replace(new RegExp(SECRET_ASSIGNMENT, "gi"), (_match, name: string, quote?: string) =>
    quote ? `${name}${quote}[REDACTED]${quote}` : `${name}[REDACTED]`,
  );
  for (const source of SECRET_TOKENS) redacted = redacted.replace(new RegExp(source, "g"), "[REDACTED]");
  return redacted
    .replace(new RegExp(AUTH_HEADER, "gi"), "$1[REDACTED]")
    .replace(new RegExp(BEARER_TOKEN, "gi"), "Bearer [REDACTED]")
    .replace(new RegExp(URL_CREDENTIAL, "gi"), "$1[REDACTED]$2")
    .replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, PRIVATE_KEY_MASK)
    .replace(new RegExp(OPAQUE_VALUE, "g"), "[REDACTED]");
}

/** Filter for anything shown or spoken as an answer: secrets, money figures and phone numbers. */
export function redactAnswer(text: string): string {
  return scrubKnowledge(redactSecrets(text));
}

/** Redacted characters held back, because a later chunk can complete a sensitive value. */
const STREAM_HOLDBACK_CHARS = 120;
/** New characters collected before the accumulated text is redacted again. */
const STREAM_RECHECK_CHARS = 24;

/** Incrementally redacts model text before it is shown live. */
export interface StreamRedactor {
  /** Adds a chunk and returns text that is safe to release now. */
  push(delta: string): string;
  /** Returns the remaining text at the end of the stream. */
  finish(): string;
}

/**
 * Creates a stream redactor. Redaction always runs over the whole accumulated text, so a credential
 * name and value are still seen together when they arrive in different chunks.
 */
export function createStreamRedactor(): StreamRedactor {
  let raw = "";
  let sent = 0;
  let unchecked = 0;
  return {
    push(delta) {
      raw += delta;
      unchecked += delta.length;
      if (unchecked < STREAM_RECHECK_CHARS) return "";
      unchecked = 0;
      const clean = redactAnswer(raw);
      let stable = clean.length - STREAM_HOLDBACK_CHARS;
      // Never release part of an unbroken value, because later text could complete it.
      while (stable > sent && !/\s/.test(clean[stable - 1] ?? "")) stable -= 1;
      if (stable <= sent) return "";
      const ready = clean.slice(sent, stable);
      sent = stable;
      return ready;
    },
    finish() {
      const rest = redactAnswer(raw).slice(sent);
      raw = "";
      sent = 0;
      unchecked = 0;
      return rest;
    },
  };
}
