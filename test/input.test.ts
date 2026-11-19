import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARS, MAX_INPUT_LINES, MAX_LINE_CHARS, parseChange } from "../src/domain/input";
import { changeTextSchema, parseInput, reasonSchema } from "../src/domain/schemas";
import { diffFor, parsed } from "./fixtures";

const validateChangeInput = (value: unknown) => parseInput(changeTextSchema, value);
const validateReason = (value: unknown) => parseInput(reasonSchema, value);

describe("input limits", () => {
  it.each([[null], [undefined], [42], [{ text: "x" }], [["x"]]])("rejects non-text input %j", (value) => {
    expect(validateChangeInput(value).ok).toBe(false);
  });

  it("rejects blank input", () => {
    expect(validateChangeInput(" \n\t ").ok).toBe(false);
  });

  it("rejects oversized input instead of truncating it", () => {
    const result = validateChangeInput("x".repeat(MAX_INPUT_CHARS + 1));
    expect(result).toMatchObject({ ok: false });
    expect(validateChangeInput(`${"x".repeat(99)}\n`.repeat(MAX_INPUT_CHARS / 100)).ok).toBe(true);
  });

  it("rejects too many lines", () => {
    expect(validateChangeInput("x\n".repeat(MAX_INPUT_LINES)).ok).toBe(false);
  });

  it("rejects very long lines that could make pattern matching expensive", () => {
    expect(validateChangeInput("a-".repeat(MAX_LINE_CHARS)).ok).toBe(false);
  });

  it("rejects binary control characters", () => {
    expect(validateChangeInput("safe\u0000text").ok).toBe(false);
  });

  it("normalizes Windows line endings", () => {
    expect(validateChangeInput("a\r\nb")).toEqual({ ok: true, data: "a\nb" });
  });

  it("requires a meaningful exception reason", () => {
    expect(validateReason("short").ok).toBe(false);
    expect(validateReason("Approved until the partner migration ends.").ok).toBe(true);
    expect(validateReason(7).ok).toBe(false);
  });
});

describe("diff parser", () => {
  it("reads paths, line numbers and additions", () => {
    const change = parsed(diffFor("src/app.ts", ["const a = 1;"], ["// header"]));
    expect(change.kind).toBe("diff");
    expect(change.files[0]).toMatchObject({
      path: "src/app.ts",
      additions: [{ line: 2, text: "const a = 1;" }],
      context: [{ line: 1, text: "// header" }],
    });
  });

  it("treats plain text as a summary", () => {
    expect(parsed("Rename a helper function.").kind).toBe("summary");
  });

  it("does not mistake hunk content for a file header", () => {
    const text = ["--- a/a.txt", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+++ b/hidden.txt", "+visible"].join("\n");
    const change = parsed(text);
    expect(change.files).toHaveLength(1);
    expect(change.files[0]?.additions.map((line) => line.text)).toEqual(["++ b/hidden.txt", "visible"]);
  });

  it.each([
    ["a truncated hunk", "--- a/a\n+++ b/a\n@@ -1,1 +1,3 @@\n+only one"],
    ["a hunk with no file", "@@ -1 +1 @@\n-a\n+b"],
    ["an invalid hunk header", "--- a/a\n+++ b/a\n@@ nonsense @@\n+a"],
    ["a missing +++ header", "--- a/a\n@@ -1 +1 @@\n-a\n+b"],
    ["an invalid hunk line", "--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n?what"],
    ["added lines past the declared count", "--- a/a\n+++ b/a\n@@ -0,0 +1,1 @@\n+one\n+hidden"],
    ["an unreadable file header", "diff --git nonsense"],
  ])("fails closed on %s", (_name, text) => {
    expect(parseChange(text).ok).toBe(false);
  });
});
