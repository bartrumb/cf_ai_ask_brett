/*
 * Rules for profile content: the shape of `site.json`, what public copy may say, and how the
 * private knowledge base becomes model context. `scripts/build-content.mjs` runs this file directly
 * under Node, so it imports only zod and must not use extensionless relative imports.
 */
import { z } from "zod";

/** Replaces every money figure in model context. The system prompt explains the marker. */
export const WITHHELD_AMOUNT = "[amount withheld]";

/** Titles that may appear as the held title. Target roles belong in `seeking`, never here. */
export const HELD_TITLES = [
  "Senior DevOps Engineer",
  "Senior Cloud Engineer",
  "Founder",
  "Principal Engineer of Shepherd",
  "Solutions Architecture Consultant",
] as const;

/** Money amounts, including approximations and suffixes. A bare `$0` is left alone. */
const MONEY = /[~≈]?\$\s?(?!0(?!\d|[.,]\d))\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|thousand)\b|[kKmMbB]\b)?\+?/g;
/** North American style phone numbers, with or without separators. */
const PHONE = /(?<![\d.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g;
/** Senior role names that may only be described as a goal. */
const TARGET_ROLE = /\b(?:staff|principal)(?:\s*(?:,|or|and|\/)\s*(?:staff|principal))?\s+(?:[a-z]+\s+)?(?:engineer|ic|architect|roles?)\b|\bforward[- ]deployed\b/i;
/** Wording that marks a role as a goal instead of a held title. */
const SEEKING = /\b(?:seeking|looking for|open to|targeting)\b/i;
/** Heading of the agent-instruction section, recognized by number or by name. */
const PRIVATE_HEADING = /^##\s+(?:0\s*[.:)-]|.*\b(?:instructions for the agent|system prompt)\b)/i;

const text = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z.url({ protocol: /^https$/ }).max(300);

/** Validated shape of `site.json`. Strict objects stop unreviewed fields reaching the public page. */
export const siteSchema = z.strictObject({
  name: text(80),
  title: z.enum(HELD_TITLES),
  tagline: text(160),
  location: text(100),
  seeking: text(220),
  about: text(600),
  links: z.strictObject({
    email: z.email().max(254),
    site: httpsUrl,
    linkedin: httpsUrl,
    github: httpsUrl,
    resume: httpsUrl,
  }),
  stats: z.array(z.strictObject({ value: text(16), label: text(70) })).length(4),
  proof: z.array(z.strictObject({ title: text(60), result: text(110), detail: text(280) })).min(5).max(7),
  projects: z.array(z.strictObject({ name: text(60), summary: text(260), url: httpsUrl, tags: z.array(text(30)).min(1).max(5) })).min(3).max(5),
  skills: z.array(z.strictObject({ group: text(40), items: z.array(text(40)).min(3).max(14) })).min(3).max(7),
  questions: z.array(text(120)).length(8),
});

/** Public profile data served to the browser. */
export type SiteContent = z.infer<typeof siteSchema>;

/** One retrievable part of the sanitized knowledge base. */
export interface KnowledgeSection {
  title: string;
  body: string;
}

/** Yields every string in a JSON value. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* strings(item);
}

/** True when text contains a money figure. */
const hasMoney = (value: string) => value.search(MONEY) !== -1;
/** True when text contains a phone number. */
const hasPhone = (value: string) => value.search(PHONE) !== -1;

/**
 * Validates public copy beyond its shape.
 *
 * @throws Error naming the rule and field text that failed. Build output is local, so this is safe.
 */
export function parseSite(raw: unknown): SiteContent {
  const site = siteSchema.parse(raw);
  for (const value of strings(site)) {
    if (hasMoney(value)) throw new Error(`Public copy may not contain money figures: "${value}"`);
    if (hasPhone(value)) throw new Error(`Public copy may not contain phone numbers: "${value}"`);
    const withoutHeldTitle = value.replaceAll("Principal Engineer of Shepherd", "");
    if (TARGET_ROLE.test(withoutHeldTitle) && !SEEKING.test(value)) {
      throw new Error(`Target roles must use "seeking" language: "${value}"`);
    }
  }
  return site;
}

/**
 * Removes the title block and the agent-instruction section, keeping only numbered profile sections.
 * Everything before the first `##` heading is dropped, so new metadata cannot slip through.
 */
export function stripPrivateSections(markdown: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.lines.filter((line) => line.trim() !== "---").join("\n").trim();
    if (body) sections.push({ title: current.title, body });
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.startsWith("## ")) {
      current?.lines.push(line);
      continue;
    }
    close();
    current = PRIVATE_HEADING.test(line) ? null : { title: line.slice(3).trim(), lines: [] };
  }
  close();
  return sections;
}

/** Masks money figures and phone numbers, so the model never holds them. */
export function scrubKnowledge(value: string): string {
  return value.replace(MONEY, WITHHELD_AMOUNT).replace(PHONE, "[number withheld]");
}

/**
 * Produces model context from the raw knowledge base.
 *
 * @throws Error when nothing usable remains or a line of the removed section survived.
 */
export function buildKnowledge(markdown: string): KnowledgeSection[] {
  const sections = stripPrivateSections(markdown).map(({ title, body }) => ({ title: scrubKnowledge(title), body: scrubKnowledge(body) }));
  if (sections.length === 0) throw new Error("The knowledge base has no profile sections.");
  const output = sections.map(({ title, body }) => `${title}\n${body}`).join("\n");
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && PRIVATE_HEADING.test(line));
  if (start !== -1) {
    const offset = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
    const removed = lines.slice(start, offset === -1 ? undefined : start + 1 + offset);
    for (const line of removed) {
      if (line.trim().length >= 24 && output.includes(line.trim())) throw new Error("Removed instructions leaked into model context.");
    }
  }
  return sections;
}

/** Renders the gitignored TypeScript module the Worker imports. */
export function renderKnowledgeModule(sections: KnowledgeSection[], site: SiteContent): string {
  const profile = { name: site.name, title: site.title, location: site.location, links: site.links };
  return [
    "// Generated by scripts/build-content.mjs. Do not edit or commit.",
    `export const KNOWLEDGE_SECTIONS: readonly { title: string; body: string }[] = ${JSON.stringify(sections)};`,
    `export const PROFILE = ${JSON.stringify(profile)} as const;`,
    "",
  ].join("\n");
}
