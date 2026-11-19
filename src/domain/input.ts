/*
 * Input limits, text normalization and the unified-diff parser. The parser's output is the only
 * view of a change that the rule engine sees, so its strictness is part of the security boundary.
 */
/** Largest accepted change, in characters. */
export const MAX_INPUT_CHARS = 40_000;
/** Largest accepted change, in lines. */
export const MAX_INPUT_LINES = 4_000;
/** Longest accepted line. This also bounds regular-expression work per line. */
export const MAX_LINE_CHARS = 2_000;
/** Longest accepted follow-up question. */
export const MAX_QUESTION_CHARS = 2_000;
/** Shortest accepted exception reason. */
export const MIN_REASON_CHARS = 10;
/** Longest accepted exception reason. */
export const MAX_REASON_CHARS = 500;

/** Pseudo-path for a plain-language change summary. */
export const SUMMARY_PATH = "(summary)";
/** Pseudo-path for text before the first diff header, such as a commit message. */
export const PREAMBLE_PATH = "(preamble)";

/** One line of a change. `line` is its new-file number, or its input line outside hunks. */
export interface ChangeLine {
  line: number;
  text: string;
}

/** Lines parsed for one file. Removed lines are counted but their text is not kept. */
export interface ChangedFile {
  path: string;
  additions: ChangeLine[];
  context: ChangeLine[];
  deletions: number;
}

/** A submitted change, read either as a unified diff or as a plain summary. */
export interface ParsedChange {
  kind: "diff" | "summary";
  files: ChangedFile[];
}

/** Parsed change, or a message that can be shown to the user. */
export type ParseResult =
  | { ok: true; change: ParsedChange }
  | { ok: false; error: string };

/** Soft hyphen, zero-width and bidirectional control characters, and the byte order mark. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Removes characters that can hide text from people and from pattern matching.
 * NFKC also folds compatibility forms such as full-width letters into their plain equivalents.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

/** Any of these makes the input a diff, which then has to parse strictly. */
const DIFF_MARKER = /^(diff --git |--- \S.*\n\+\+\+ \S|@@ -\d)/m;
/** Captures the old count, new start and new count. Omitted counts mean 1. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Git header lines that carry nothing the rules inspect. */
const FILE_METADATA =
  /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;

/**
 * Normalizes a path from a diff header and strips its `a/` or `b/` prefix. Paths are capped at 200.
 */
function cleanPath(raw: string): string {
  const withoutTab = raw.split("\t")[0] ?? "";
  const unquoted = withoutTab.trim().replace(/^"|"$/g, "");
  return normalizeText(unquoted).replace(/^[ab]\//, "").slice(0, 200) || "(unknown)";
}

/** Creates an empty file record. */
function newFile(path: string): ChangedFile {
  return { path, additions: [], context: [], deletions: 0 };
}

/** Builds the parse failure for a line, numbered from 1 for the user. */
function malformed(lineNumber: number, detail: string): ParseResult {
  return { ok: false, error: `This looks like a diff, but line ${lineNumber} is malformed: ${detail}` };
}

/** Treats each non-blank line as added text, so summaries run through the same rule loop. */
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
 * Blank lines and git metadata lines outside hunks are skipped and are not scanned.
 *
 * @param text - Input with line endings already normalized by the request schema.
 * @returns A diff or summary, or an error naming the first malformed line.
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

    // Inside a hunk, the declared counts decide how each line is read.
    if (oldLeft > 0 || newLeft > 0) {
      const file = current as ChangedFile | null;
      if (!file) return malformed(lineNumber, "hunk content has no file.");
      const marker = line[0];
      // `\ No newline at end of file` belongs to the previous line.
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
        // Some tools strip the trailing space from blank context lines.
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
      // These headers refine a `diff --git` entry. After hunks, they begin a new file.
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
  // Added last so real files keep their order. Preamble text counts as context, never additions.
  if (preamble.context.length > 0) files.push(preamble);
  return { ok: true, change: { kind: "diff", files } };
}
