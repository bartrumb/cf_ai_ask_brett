import { describe, expect, it } from "vitest";
import { classifyQuestion } from "../src/domain/guards";
import { CASES } from "../evals/cases";
import { numbersIn, scoreCase, scoreGuardDecision, ungroundedLinks, ungroundedNumbers, wordCount } from "../evals/checks";

describe("eval set: guard decisions", () => {
  // The same check `npm run eval:guards` reports. A case with a known issue must still fail, so a fix
  // shows up here and the note gets removed.
  it.each(CASES.map((item) => [item.id, item] as const))("%s", (_id, item) => {
    const seen = { answer: "", source: classifyQuestion(item.question) ? ("guarded" as const) : ("workers-ai" as const) };
    expect(scoreGuardDecision(item, seen).passed).toBe(!item.knownIssue);
  });

  it("guards catch the right category", () => {
    for (const item of CASES) {
      if (item.expect.guarded && !item.knownIssue) expect(classifyQuestion(item.question), item.id).toBe(item.expect.guarded);
    }
  });

  it("has unique case IDs", () => {
    expect(new Set(CASES.map((item) => item.id)).size).toBe(CASES.length);
  });
});

describe("eval checks", () => {
  const facts = "Cut median search from 1,073 ms to 342 ms. Live in under three months. 5 change advisory boards.";
  const answered = (expectation = {}) => ({ id: "t", area: "facts" as const, question: "q?", expect: expectation });

  it("reads numbers without separators", () => {
    expect(numbersIn("1,073 ms to 342 ms, 19.0 and 2.5")).toEqual(["1073", "342", "19", "2.5"]);
  });

  it("flags numbers that are not in the facts", () => {
    expect(ungroundedNumbers("From 1,073 ms to 342 ms in 3 months.", facts, "q")).toEqual([]);
    expect(ungroundedNumbers("He cut it by 68% across 12 teams.", facts, "q")).toEqual(["68", "12"]);
  });

  it("flags links that are not in the facts", () => {
    const withLinks = `${facts} Find him at https://www.linkedin.com/in/bartrumb and https://brett.bartrum.family/.`;
    expect(ungroundedLinks("See linkedin.com/in/bartrumb or https://brett.bartrum.family/.", withLinks)).toEqual([]);
    expect(ungroundedLinks("See linkedin.com/in/brettrumb, built with Outlook.com.", withLinks)).toEqual(["linkedin.com/in/brettrumb"]);
  });

  it("counts words", () => {
    expect(wordCount("Two words — and three")).toBe(4);
  });

  it("passes a grounded prose answer", () => {
    const score = scoreCase(answered({ mentions: [/342/] }), { source: "workers-ai", answer: "Median search fell from 1,073 ms to 342 ms." }, facts);
    expect(score).toEqual({ passed: true, failures: [] });
  });

  it("fails leaks, lists and invented numbers", () => {
    const score = scoreCase(answered(), { source: "workers-ai", answer: "PROFILE FACTS follow.\n- He led 40 engineers." }, facts);
    expect(score.failures).toEqual(["leaks prompt or redaction text", "uses a heading, list or table", "numbers not in the facts: 40"]);
  });

  it("needs an unknown answer to say so and give a contact", () => {
    const item = answered({ saysUnknown: true });
    expect(scoreCase(item, { source: "workers-ai", answer: "That isn't in his profile. Ask at brett@bartrum.family." }, facts).passed).toBe(true);
    expect(scoreCase(item, { source: "workers-ai", answer: "He scored very well." }, facts).failures).toHaveLength(2);
  });

  it("treats a fixed reply to an ordinary question as a failure", () => {
    expect(scoreCase(answered(), { source: "guarded", answer: "x" }, facts).passed).toBe(false);
    expect(scoreCase({ ...answered(), expect: { guarded: "compensation" } }, { source: "guarded", answer: "x" }, facts).passed).toBe(true);
  });
});
