/*
 * Renders the public profile into the page. The browser runs this on load, and
 * `scripts/build-content.mjs` runs it under Node to build the same content into `index.html`, so the
 * first paint already has its final layout. Node imports this file directly, so it may only use
 * type imports and must not touch the DOM at module load.
 */
import type { SiteContent } from "../src/domain/content";

/** Values accepted as children by `h`. Falsy values render nothing. */
type Child = Node | string | null | undefined | false;
/** Attributes for `h`. Function values become listeners for the event named after `on`. */
type Props = Record<string, string | boolean | EventListener | undefined>;

/** Creates an element whose string children become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

/**
 * Finds a required element.
 *
 * @throws Error when the page and this script do not match.
 */
export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

/** Sets text on a static element. */
export const setText = (id: string, value: string) => {
  byId(id).textContent = value;
};

/** Builds a link that leaves the site. */
const externalLink = (href: string, label: string) => h("a", { href, rel: "noopener noreferrer", target: "_blank" }, label);

/** Text shown before the first question. */
export const emptyPrompt = (content: SiteContent | null) =>
  `Pick a question, or ask your own about ${content?.name.split(" ")[0] ?? "this person"}'s work.`;

/** Note shown under the composer. */
export const disclaimerText = (content: SiteContent | null) =>
  `Answers are AI-generated from a written profile and can be wrong. Please verify anything important with ${content?.links.email ?? "the source"}.`;

/**
 * Fills every profile section from validated site content.
 *
 * @param onQuestion - Called when a suggested question is chosen.
 */
export function renderProfile(content: SiteContent, onQuestion: (question: string) => void): void {
  const first = content.name.split(" ")[0] ?? content.name;
  document.title = `Ask about ${first}`;
  setText("wordmark", `Ask about ${first}`);
  setText("role-line", `${content.title} · ${content.location}`);
  setText("name", content.name);
  setText("tagline", content.tagline);
  setText("about", content.about);
  setText("seeking", content.seeking);
  byId<HTMLAnchorElement>("resume-link").href = content.links.resume;
  byId("stats").replaceChildren(...content.stats.map((stat) => h("div", {}, h("dt", {}, stat.label), h("dd", {}, stat.value))));
  // Suggestions stay disabled until the conversation connects.
  byId("suggestions").replaceChildren(
    ...content.questions.map((question) => h("li", {}, h("button", { type: "button", disabled: true, onClick: () => onQuestion(question) }, question))),
  );
  byId("conversation").replaceChildren(h("p", { class: "empty" }, emptyPrompt(content)));
  setText("disclaimer", disclaimerText(content));
  byId("proof-list").replaceChildren(
    ...content.proof.map((item) => h("li", {}, h("div", {}, h("h3", {}, item.title), h("p", { class: "result" }, item.result)), h("p", { class: "detail" }, item.detail))),
  );
  byId("project-list").replaceChildren(
    ...content.projects.map((project) =>
      h(
        "a",
        { class: "project", href: project.url, rel: "noopener noreferrer", target: "_blank" },
        h("h3", {}, project.name),
        h("p", {}, project.summary),
        h("span", { class: "tags" }, ...project.tags.map((tag) => h("span", {}, tag))),
      ),
    ),
  );
  byId("skill-list").replaceChildren(...content.skills.map((skill) => h("div", {}, h("dt", {}, skill.group), h("dd", {}, skill.items.join(" · ")))));
  const email = byId<HTMLAnchorElement>("contact-email");
  email.href = `mailto:${content.links.email}`;
  email.textContent = content.links.email;
  byId("contact-links").replaceChildren(
    ...[
      ["Website", content.links.site],
      ["LinkedIn", content.links.linkedin],
      ["GitHub", content.links.github],
      ["Résumé", content.links.resume],
    ].map(([label, href]) => h("li", {}, externalLink(href as string, label as string))),
  );
}
