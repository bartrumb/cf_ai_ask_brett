import { describe, expect, it } from "vitest";
import { buildSpokenReview, MAX_SPOKEN_CHARS, toSpokenText } from "../src/domain/audio";
import { applyGateway } from "../src/domain/gateway-config";
import { parseChange } from "../src/domain/input";
import { auditCommentary, buildQuestionPrompt, offlineAnswer, offlineCommentary } from "../src/domain/prompt";
import { describeChange, evaluateChange } from "../src/domain/rules";
import { isAllowedClientFrame, parseInput, speakRequestSchema } from "../src/domain/schemas";
import type { RuleResult } from "../src/domain/types";
import { isGuardrailBlock } from "../src/gateway";
import { generateText } from "../src/llm";
import { MODELS } from "../src/models";
import { synthesizeSpeech, transcribeAudio } from "../src/speech";
import { allStandards, diffFor, OPEN_INGRESS, parsed } from "./fixtures";

const context = { standards: allStandards(), exceptions: [] };
const ingress = () => evaluateChange(parsed(OPEN_INGRESS), context);
const gateway = { repository: "repo", feature: "speech" } as const;
const envWith = (run: (model: string, input: unknown, options: unknown) => unknown) => ({
  AI: { run: async (model: string, input: unknown, options: unknown) => run(model, input, options) } as unknown as Ai,
  AI_MODE: "workers-ai",
  AI_GATEWAY_ID: "gw",
});

describe("diff parser edge cases", () => {
  it("handles quoted paths, deleted files, metadata and no-newline markers", () => {
    const text = [
      'diff --git "a/old name.txt" "b/old name.txt"',
      "deleted file mode 100644",
      "index 111..000",
      '--- "a/old name.txt"\t2026',
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parsed(text).files[0]).toMatchObject({ path: "old name.txt", deletions: 1 });
  });

  it.each([
    ["text between hunks", "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\nunexpected"],
    ["too many removed lines", "--- a/a\n+++ b/a\n@@ -0,0 +1,1 @@\n-a\n+b"],
    ["context after the new side is complete", "--- a/a\n+++ b/a\n@@ -1,2 +1,1 @@\n+b\n context"],
  ])("rejects %s", (_name, text) => {
    expect(parseChange(text).ok).toBe(false);
  });

  it("starts a new file for a second header pair and titles long changes", () => {
    const text = ["a", "b", "c"].map((name) => `--- a/${name}\n+++ b/${name}\n@@ -0,0 +1 @@\n+x`).join("\n");
    const change = parsed(text);
    expect(change.files).toHaveLength(3);
    expect(describeChange(change, text)).toBe("a, b and 1 more");
    expect(describeChange(parsed("\n  First line\nSecond"), "\n  First line\nSecond")).toBe("First line");
  });
});

describe("prompts and offline text", () => {
  it("handles having no review yet", () => {
    expect(buildQuestionPrompt("Hello", null, "n")[1]?.content).toContain("No review has run yet");
    expect(offlineAnswer(null)).toContain("No review");
  });

  it("describes clean, single-finding and excepted results", () => {
    const clean = evaluateChange(parsed(diffFor("docs/a.md", ["Text"])), context);
    expect(offlineCommentary(clean)).toContain("No rule matched");
    expect(offlineAnswer(clean)).toContain("no open findings");
    expect(offlineAnswer(ingress())).toContain("1 open finding:");
    const finding = ingress().findings[0];
    if (!finding) throw new Error("Expected a finding.");
    const excepted: RuleResult = { ...ingress(), findings: [{ ...finding, status: "excepted", exceptionId: "e" }] };
    expect(offlineCommentary(excepted)).toContain("accepted exception");
    expect(offlineCommentary({ ...ingress(), findings: [{ ...finding, line: null, standardId: "STD-UNKNOWN-01" }] })).toContain("infra/network.tf.");
    expect(auditCommentary("F1 risk: high", ingress())).toEqual([]);
  });

  it("builds natural spoken text", () => {
    const empty = evaluateChange(parsed(diffFor("docs/a.md", ["Text"])), context);
    expect(buildSpokenReview(empty, "")).toBe("Rule engine result: low risk, with 0 open findings.");
    expect(toSpokenText("x".repeat(MAX_SPOKEN_CHARS + 1))).toHaveLength(MAX_SPOKEN_CHARS);
  });
});

describe("schema guards", () => {
  it.each([
    [123],
    ["not json"],
    ["[]"],
    [JSON.stringify({ type: "rpc", id: "1", method: "getSnapshot", args: [1, 2] })],
    [JSON.stringify({ type: "rpc", id: "1", method: "getSnapshot", args: [], stream: true })],
    ["x".repeat(2_000_000)],
  ])("rejects frame %#", (frame) => {
    expect(isAllowedClientFrame(frame)).toBe(false);
  });

  it("uses a safe default when a schema has no issue message", () => {
    expect(parseInput(speakRequestSchema, null)).toEqual({ ok: false, error: "There is nothing to read aloud yet." });
  });
});

describe("model failure paths", () => {
  const request = { messages: [{ role: "user" as const, content: "Hi" }], offlineText: "", maxOutputTokens: 5, gateway, onDelta: () => {} };

  it("surfaces an error when every language model fails", async () => {
    const env = envWith(() => Response.json({ errors: [{ message: "unavailable" }] }, { status: 500 }));
    await expect(generateText(env, request)).rejects.toThrow();
  });

  it("rejects an empty model answer", async () => {
    const env = envWith(() => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    await expect(generateText(env, request)).rejects.toThrow();
  });

  it("falls back when transcription returns an unexpected shape", async () => {
    const env = envWith((model) => (model === MODELS.stt.primary ? {} : { text: " done " }));
    await expect(transcribeAudio(env, new Uint8Array(50), gateway)).resolves.toMatchObject({ text: "done", model: MODELS.stt.secondary });
  });

  it("fails when both transcription models return unexpected shapes", async () => {
    await expect(transcribeAudio(envWith(() => ({})), new Uint8Array(50), gateway)).rejects.toThrow("Unexpected");
  });

  it("accepts raw audio streams and reports non-Error speech failures", async () => {
    const env = envWith(() => new Response(new Uint8Array([1])).body);
    await expect(synthesizeSpeech(env, "Hi", gateway)).resolves.toMatchObject({ audio: "AQ==" });
    let calls = 0;
    const flaky = envWith(() => {
      calls += 1;
      if (calls === 1) throw "failure";
      return new Response(new Uint8Array([1]));
    });
    await expect(synthesizeSpeech(flaky, "Hi", gateway)).resolves.toMatchObject({ model: MODELS.tts.secondary });
  });

  it("recognizes block errors that are not Error objects", () => {
    expect(isGuardrailBlock("code 2017")).toBe(true);
    expect(isGuardrailBlock(new Error("wrapped", { cause: "Prompt blocked due to security configurations" }))).toBe(true);
  });
});

describe("gateway setup failures", () => {
  it("handles API errors without a JSON body", async () => {
    const fetcher = (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const environment = { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), CLOUDFLARE_API_TOKEN: "test_token_value_123456" };
    await expect(applyGateway(environment, fetcher)).rejects.toThrow("no details returned");
  });
});
