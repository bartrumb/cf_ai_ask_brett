import { describe, expect, it } from "vitest";
import { dropUnfinishedSentence } from "../src/domain/prompt";

const long = "A complete sentence. ".repeat(100).trim();

describe("unfinished answers", () => {
  it("ends a long cut-off answer at its last full sentence", () => {
    expect(dropUnfinishedSentence(`${long} This one stops without`)).toBe(long);
  });

  it("keeps a long answer that finished", () => {
    expect(dropUnfinishedSentence(long)).toBe(long);
  });

  it("keeps short answers without final punctuation", () => {
    expect(dropUnfinishedSentence("See the site. It has more detail")).toBe("See the site. It has more detail");
  });

  it("keeps a long answer with no sentence boundary", () => {
    const text = "word ".repeat(500).trim();
    expect(dropUnfinishedSentence(text)).toBe(text);
  });
});
