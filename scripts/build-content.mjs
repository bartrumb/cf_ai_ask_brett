// Generates src/generated/knowledge.ts and public/site.json before builds, tests and type checks.
// Private files in content/ are used when both exist; otherwise the invented examples are used.
// Set CONTENT_MODE=example to force the examples. Node runs the TypeScript import directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKnowledge, parseSite, renderKnowledgeModule } from "../src/domain/content.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inContent = (name) => join(root, "content", name);

/** Writes only on change, so watchers and incremental tools stay quiet. */
function writeIfChanged(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== value) writeFileSync(path, value);
}

const hasKnowledge = existsSync(inContent("knowledge-base.md"));
const hasSite = existsSync(inContent("site.json"));
const useReal = process.env.CONTENT_MODE !== "example" && hasKnowledge && hasSite;
if (process.env.CONTENT_MODE !== "example" && hasKnowledge !== hasSite) {
  console.warn("content: only one private file is present, so the examples are being used.");
}

try {
  const markdown = readFileSync(inContent(useReal ? "knowledge-base.md" : "knowledge-base.example.md"), "utf8");
  const site = parseSite(JSON.parse(readFileSync(inContent(useReal ? "site.json" : "site.example.json"), "utf8")));
  const sections = buildKnowledge(markdown);
  writeIfChanged(join(root, "src", "generated", "knowledge.ts"), renderKnowledgeModule(sections, site));
  writeIfChanged(join(root, "public", "site.json"), `${JSON.stringify(site, null, 2)}\n`);
  console.log(`content: generated from ${useReal ? "private content" : "examples"} (${sections.length} sections).`);
} catch (error) {
  console.error(`content: ${error instanceof Error ? error.message : "generation failed"}`);
  process.exitCode = 1;
}
