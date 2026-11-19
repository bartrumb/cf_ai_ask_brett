export const MAX_INPUT_CHARS = 40_000;
export const MAX_INPUT_LINES = 4_000;
export const MAX_QUESTION_CHARS = 2_000;
export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 500;

export const SUMMARY_PATH = "(summary)";
export const PREAMBLE_PATH = "(preamble)";

export type Validated =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface ChangeLine {
  line: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  additions: ChangeLine[];
  context: ChangeLine[];
  deletions: number;
}

export interface ParsedChange {
  kind: "diff" | "summary";
  files: ChangedFile[];
}

export type ParseResult =
  | { ok: true; change: ParsedChange }
  | { ok: false; error: string };

const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Removes characters that can hide text from people and from pattern matching. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

function validateText(raw: unknown, label: string, maxChars: number): Validated {
  if (typeof raw !== "string") return { ok: false, error: `${label} must be text.` };
  const text = raw.replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) return { ok: false, error: `${label} is empty.` };
  if (text.length > maxChars) {
    return {
      ok: false,
      error: `${label} is ${text.length.toLocaleString("en-US")} characters. The limit is ${maxChars.toLocaleString("en-US")}. Split the change and review it in parts.`,
    };
  }
  if (FORBIDDEN_CONTROL.test(text)) {
    return { ok: false, error: `${label} contains binary or control characters.` };
  }
  return { ok: true, text };
}

/**
 * Oversized input is rejected, never truncated. Truncating would let a risky
 * line sit past the cap while the rule engine reports a clean result.
 */
export function validateChangeInput(raw: unknown): Validated {
  const result = validateText(raw, "The change", MAX_INPUT_CHARS);
  if (!result.ok) return result;
  const lines = result.text.split("\n").length;
  if (lines > MAX_INPUT_LINES) {
    return {
      ok: false,
      error: `The change has ${lines.toLocaleString("en-US")} lines. The limit is ${MAX_INPUT_LINES.toLocaleString("en-US")}.`,
    };
  }
  return result;
}

export function validateQuestion(raw: unknown): Validated {
  return validateText(raw, "The question", MAX_QUESTION_CHARS);
}

export function validateReason(raw: unknown): Validated {
  const result = validateText(raw, "The reason", MAX_REASON_CHARS);
  if (!result.ok) return result;
  const text = normalizeText(result.text).trim();
  if (text.length < MIN_REASON_CHARS) {
    return { ok: false, error: `Give a reason of at least ${MIN_REASON_CHARS} characters.` };
  }
  return { ok: true, text };
}

const DIFF_MARKER = /^(diff --git |--- \S.*\n\+\+\+ \S|@@ -\d)/m;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FILE_METADATA =
  /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;

function cleanPath(raw: string): string {
  const withoutTab = raw.split("\t")[0] ?? "";
  const unquoted = withoutTab.trim().replace(/^"|"$/g, "");
  return normalizeText(unquoted).replace(/^[ab]\//, "").slice(0, 200) || "(unknown)";
}

function newFile(path: string): ChangedFile {
  return { path, additions: [], context: [], deletions: 0 };
}

function malformed(lineNumber: number, detail: string): ParseResult {
  return { ok: false, error: `This looks like a diff, but line ${lineNumber} is malformed: ${detail}` };
}

function parseSummary(text: string): ParseResult {
  const file = newFile(SUMMARY_PATH);
  text.split("\n").forEach((value, index) => {
    if (value.trim()) file.additions.push({ line: index + 1, text: value });
  });
  return { ok: true, change: { kind: "summary", files: [file] } };
}

/**
 * Hunk line counts decide what is content, so a content line such as
 * `+++ b/other` cannot pose as a file header. Anything unexpected fails closed:
 * ignoring it could hide added lines from the rules.
 */
export function parseChange(text: string): ParseResult {
  if (!DIFF_MARKER.test(text)) return parseSummary(text);

  const lines = text.split("\n");
  const files: ChangedFile[] = [];
  const preamble = newFile(PREAMBLE_PATH);
  let current: ChangedFile | null = null;
  let currentHasHunks = false;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  const startFile = (path: string): ChangedFile => {
    const file = newFile(path);
    files.push(file);
    current = file;
    currentHasHunks = false;
    return file;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    if (oldLeft > 0 || newLeft > 0) {
      const file = current as ChangedFile | null;
      if (!file) return malformed(lineNumber, "hunk content has no file.");
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "+") {
        if (newLeft === 0) return malformed(lineNumber, "more added lines than the hunk header declares.");
        file.additions.push({ line: newLine, text: line.slice(1) });
        newLine += 1;
        newLeft -= 1;
      } else if (marker === "-") {
        if (oldLeft === 0) return malformed(lineNumber, "more removed lines than the hunk header declares.");
        file.deletions += 1;
        oldLeft -= 1;
      } else if (marker === " " || line === "") {
        if (oldLeft === 0 || newLeft === 0) return malformed(lineNumber, "more context lines than the hunk header declares.");
        file.context.push({ line: newLine, text: line.slice(1) });
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else {
        return malformed(lineNumber, "expected a line starting with +, - or a space.");
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/.*?"?) "?b\/(.*?)"?$/.exec(line);
      if (!match?.[1]) return malformed(lineNumber, "invalid diff --git header.");
      startFile(cleanPath(match[1]));
    } else if (line.startsWith("--- ")) {
      const next = lines[index + 1] ?? "";
      if (!next.startsWith("+++ ")) return malformed(lineNumber, "a --- header must be followed by +++.");
      const oldPath = cleanPath(line.slice(4));
      const newPath = cleanPath(next.slice(4));
      const path = newPath === "/dev/null" ? oldPath : newPath;
      const existing = current as ChangedFile | null;
      if (existing && !currentHasHunks) existing.path = path;
      else startFile(path);
      index += 1;
    } else if (line.startsWith("@@")) {
      const header = HUNK_HEADER.exec(line);
      if (!header) return malformed(lineNumber, "invalid hunk header.");
      if (!current) return malformed(lineNumber, "hunk header appears before any file header.");
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLine = Number(header[2]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
      currentHasHunks = true;
    } else if (line.startsWith("\\") || FILE_METADATA.test(line) || line.trim() === "") {
      continue;
    } else if (files.length === 0) {
      // Text before the first header, such as a commit message. Still scanned.
      preamble.context.push({ line: lineNumber, text: line });
    } else {
      return malformed(lineNumber, "unexpected text between hunks.");
    }
  }

  if (oldLeft > 0 || newLeft > 0) {
    return { ok: false, error: "This diff ends in the middle of a hunk. Paste the complete diff." };
  }
  if (files.length === 0) {
    return { ok: false, error: "This looks like a diff, but no changed file could be read." };
  }
  if (preamble.context.length > 0) files.push(preamble);
  return { ok: true, change: { kind: "diff", files } };
}
