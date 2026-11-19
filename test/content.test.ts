import { describe, expect, it } from "vitest";
import exampleKnowledge from "../content/knowledge-base.example.md?raw";
import exampleSite from "../content/site.example.json";
import generatedSite from "../public/site.json";
import { buildKnowledge, parseSite, renderKnowledgeModule, scrubKnowledge, stripPrivateSections, WITHHELD_AMOUNT, type SiteContent } from "../src/domain/content";
import { classifyQuestion } from "../src/domain/guards";
import { KNOWLEDGE_SECTIONS, PROFILE } from "../src/generated/knowledge";

const site = (): SiteContent => structuredClone(exampleSite) as SiteContent;
const SAMPLE = [
  "# Title metadata",
  "Compiled from private sources.",
  "---",
  "## 0. Instructions for the agent",
  "SENTINEL-RULE never mention the hidden subject Bluefin.",
  "---",
  "## 1. Work",
  "Built a thing for $15M+ and saved ~$5.6k, idle near $0, call 314-555-0100.",
  "---",
  "## 2. System prompt notes",
  "SENTINEL-TWO should also vanish.",
  "## 3. More",
  "Still here.",
].join("\r\n");

describe("knowledge base sanitizing", () => {
  it("removes title metadata and the instruction section", () => {
    const sections = stripPrivateSections(SAMPLE);
    expect(sections.map((section) => section.title)).toEqual(["1. Work", "3. More"]);
    const text = JSON.stringify(sections);
    for (const hidden of ["Title metadata", "Compiled", "SENTINEL", "Bluefin", "---"]) expect(text).not.toContain(hidden);
  });

  it("withholds money and phone numbers but keeps a plain zero", () => {
    const body = buildKnowledge(SAMPLE)[0]?.body ?? "";
    expect(body).toContain(`for ${WITHHELD_AMOUNT} and saved ${WITHHELD_AMOUNT}`);
    expect(body).toContain("idle near $0,");
    expect(body).not.toContain("555-0100");
    expect(scrubKnowledge("$1.33, $2 million and $0.26")).toBe(`${WITHHELD_AMOUNT}, ${WITHHELD_AMOUNT} and ${WITHHELD_AMOUNT}`);
  });

  it("fails when nothing usable remains or removed text survives", () => {
    expect(() => buildKnowledge("# Only a title")).toThrow("no profile sections");
    const repeated = "## 0. Instructions\nA private line that is long enough\n## 1. Work\nA private line that is long enough";
    expect(() => buildKnowledge(repeated)).toThrow("leaked");
  });

  it("keeps the example's private section out of its model context", () => {
    const text = JSON.stringify(buildKnowledge(exampleKnowledge));
    expect(text).not.toContain("EXAMPLE-PRIVATE-RULE");
    expect(text).not.toContain("Lanternfish");
    expect(text).toContain("Harbor Review");
  });

  it("generates context with no instruction section or money figures", () => {
    const text = JSON.stringify(KNOWLEDGE_SECTIONS);
    expect(KNOWLEDGE_SECTIONS.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/instructions for the agent|never say or reveal|EXAMPLE-PRIVATE-RULE/i);
    expect(text).not.toMatch(/\$[1-9]/);
    expect(KNOWLEDGE_SECTIONS.every((section) => !section.title.startsWith("0"))).toBe(true);
  });

  it("renders a module holding only public profile fields", () => {
    const module = renderKnowledgeModule([{ title: "T", body: "B" }], site());
    expect(module).toContain("KNOWLEDGE_SECTIONS");
    expect(module).toContain(site().links.email);
    expect(module).not.toContain(site().tagline);
  });
});

describe("site content validation", () => {
  it("accepts the example and the generated file", () => {
    expect(parseSite(site()).name).toBe("Avery Example");
    expect(parseSite(generatedSite).links.email).toBe(PROFILE.links.email);
  });

  it("offers suggested questions that reach the advocate", () => {
    for (const question of [...site().questions, ...generatedSite.questions]) expect(classifyQuestion(question), question).toBeNull();
  });

  it.each<[string, (value: SiteContent) => void, string]>([
    ["a title never held", (value) => { (value as { title: string }).title = "Staff Engineer"; }, "title"],
    ["a money figure", (value) => { value.about = "Saved $40K."; }, "money"],
    ["a phone number", (value) => { value.about = "Call 314-555-0100."; }, "phone"],
    ["a target role stated as fact", (value) => { value.about = "A Staff Engineer at heart."; }, "seeking"],
    ["Forward Deployed stated as fact", (value) => { value.tagline = "Forward Deployed Engineer."; }, "seeking"],
    ["a wrong question count", (value) => { value.questions.pop(); }, "questions"],
    ["a non-https link", (value) => { value.links.site = "http://example.com/"; }, "site"],
    ["an unreviewed field", (value) => { (value as unknown as { salary: string }).salary = "x"; }, "salary"],
  ])("rejects %s", (_name, change, message) => {
    const value = site();
    change(value);
    expect(() => parseSite(value)).toThrow(message);
  });

  it("allows target roles in seeking language and the held Shepherd title", () => {
    const value = site();
    value.seeking = "Seeking Staff or Principal roles and Forward Deployed work.";
    value.about = "Principal Engineer of Shepherd.";
    expect(parseSite(value).seeking).toContain("Seeking");
  });
});
