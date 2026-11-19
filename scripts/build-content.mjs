// Generates src/generated/knowledge.ts, public/site.json and public/index.html before builds, tests
// and type checks. Private files in content/ are used when both exist; otherwise the invented
// examples are used. Set CONTENT_MODE=example to force the examples. Node runs the TypeScript
// imports directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { renderProfile } from "../client/profile.ts";
import { buildKnowledge, parseSite, renderKnowledgeModule } from "../src/domain/content.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inContent = (name) => join(root, "content", name);

/** Writes only on change, so watchers and incremental tools stay quiet. */
function writeIfChanged(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== value) writeFileSync(path, value);
}

/** Escapes text for use inside an HTML element. */
const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Builds the page with the profile already in it, using the browser's own renderer, so the first
 * paint has its final layout. The profile is also embedded as data for the browser script.
 */
function renderPage(site) {
  const template = readFileSync(join(root, "client", "index.template.html"), "utf8");
  const window = new Window({ url: "https://localhost/" });
  globalThis.document = window.document;
  try {
    // Only the body is parsed, and markup set this way does not load or run its scripts.
    window.document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(template)[1];
    renderProfile(site, () => {});
    const title = escapeHtml(window.document.title);
    const body = window.document.body.innerHTML;
    // "<" is escaped so profile text can never close the data block.
    const data = JSON.stringify(site).replaceAll("<", "\\u003c");
    return template
      .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
      .replace(/<body>[\s\S]*<\/body>/, () => `<body>${body}</body>`)
      .replace('<script type="application/json" id="site-data"></script>', () => `<script type="application/json" id="site-data">${data}</script>`);
  } finally {
    delete globalThis.document;
    window.close();
  }
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
  writeIfChanged(join(root, "public", "index.html"), renderPage(site));
  console.log(`content: generated from ${useReal ? "private content" : "examples"} (${sections.length} sections).`);
} catch (error) {
  console.error(`content: ${error instanceof Error ? error.message : "generation failed"}`);
  process.exitCode = 1;
}
