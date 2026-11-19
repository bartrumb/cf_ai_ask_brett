import { describe, expect, it } from "vitest";
import { WITHHELD_AMOUNT } from "../src/domain/content";
import { createStreamRedactor, normalizeText, redactAnswer, redactSecrets } from "../src/domain/redaction";
import { allowedClientFrameId, conversationIdSchema, MAX_QUESTION_CHARS, parseInput, questionRequestSchema, speakRequestSchema } from "../src/domain/schemas";

const stream = (text: string, size: number) => {
  const redactor = createStreamRedactor();
  let output = "";
  for (let index = 0; index < text.length; index += size) output += redactor.push(text.slice(index, index + size));
  return output + redactor.finish();
};

describe("redaction", () => {
  it.each([
    ["API_KEY=sk-live-1234567890abcdef"],
    ["password = hunter2hunter2"],
    ['token := "abcdefghijkl"'],
    ["postgres://admin:pass1234@db.example/app"],
    [`github_pat_${"a".repeat(30)}`],
    [`xoxb-${"1".repeat(20)}`],
    [`eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`],
    [`Authorization: Bearer ${"a".repeat(32)}`],
    [`-----BEGIN ${"PRIVATE"} KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END ${"PRIVATE"} KEY-----`],
  ])("masks %s", (value) => {
    expect(redactSecrets(value)).toContain("[REDACTED");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("token_count = 12345678 and password = getPassword()")).toBe("token_count = 12345678 and password = getPassword()");
  });

  it("removes hidden characters and folds compatibility forms", () => {
    expect(normalizeText("ｓa​lary")).toBe("salary");
  });

  it("masks money and phone numbers in answers", () => {
    expect(redactAnswer("It saved $140K. Call 314-555-0100.")).toBe(`It saved ${WITHHELD_AMOUNT}. Call [number withheld].`);
  });

  it.each([
    ["a bearer token", `Authorization: Bearer ${"a".repeat(32)}`, "a".repeat(32)],
    ["a password", "password = hunter2hunter2", "hunter2hunter2"],
    ["a quoted token", 'token: "abcdefghijkl"', "abcdefghijkl"],
    ["a money figure", "He saved $140,000 there", "140,000"],
  ])("masks %s split across streamed chunks", (_name, secret, value) => {
    for (const size of [1, 5, 13]) {
      expect(stream(`${"safe ".repeat(60)}${secret} ${"more ".repeat(60)}`, size)).not.toContain(value);
    }
  });

  it("releases streamed text before the end and keeps it complete", () => {
    const redactor = createStreamRedactor();
    const text = "word ".repeat(100);
    let early = "";
    for (let index = 0; index < text.length; index += 5) early += redactor.push(text.slice(index, index + 5));
    expect(early.length).toBeGreaterThan(200);
    expect(early + redactor.finish()).toBe(text);
  });
});

describe("request schemas", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  it("caps questions at 500 characters, including after normalization", () => {
    expect(parseInput(questionRequestSchema, { question: "x".repeat(MAX_QUESTION_CHARS), requestId }).ok).toBe(true);
    expect(parseInput(questionRequestSchema, { question: "x".repeat(501), requestId }).ok).toBe(false);
    expect(parseInput(questionRequestSchema, { question: "㎉".repeat(300), requestId }).ok).toBe(false);
  });

  it.each([
    ["blank text", { question: "   ", requestId }],
    ["only hidden characters", { question: "​​", requestId }],
    ["control characters", { question: "a\u0000b", requestId }],
    ["a bad request ID", { question: "ok", requestId: "1" }],
    ["client identity", { question: "ok", requestId, visitor: "me" }],
    ["non-objects", 5],
  ])("rejects %s", (_name, value) => {
    expect(parseInput(questionRequestSchema, value).ok).toBe(false);
  });

  it("accepts only stored message targets for speech", () => {
    expect(parseInput(speakRequestSchema, { messageId: 1 }).ok).toBe(true);
    expect(parseInput(speakRequestSchema, { messageId: 0 }).ok).toBe(false);
    expect(parseInput(speakRequestSchema, { text: "Say this" }).ok).toBe(false);
  });

  it("accepts only 128-bit hex conversation IDs", () => {
    expect(conversationIdSchema.safeParse("a".repeat(32)).success).toBe(true);
    for (const value of ["default", "_daily-budget", "A".repeat(32), "a".repeat(31)]) expect(conversationIdSchema.safeParse(value).success).toBe(false);
  });

  it("allows only the four client methods", () => {
    const frame = (method: string, args: unknown[] = []) => JSON.stringify({ type: "rpc", id: "1", method, args });
    for (const method of ["getSnapshot", "ask", "transcribe", "speak"]) expect(allowedClientFrameId(frame(method))).toBe("1");
    for (const method of ["consumeDailyBudget", "expireIdleData", "clearTranscript", "submitMessages", "setState"]) expect(allowedClientFrameId(frame(method))).toBeNull();
    expect(allowedClientFrameId(frame("ask", [1, 2]))).toBeNull();
    expect(allowedClientFrameId("not json")).toBeNull();
    expect(allowedClientFrameId(new ArrayBuffer(1))).toBeNull();
    expect(allowedClientFrameId(JSON.stringify({ type: "cf_agent_state", state: {} }))).toBeNull();
  });
});
