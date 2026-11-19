/*
 * Renders answer text as DOM nodes. Only paragraphs, bold and inline code are recognized, and every
 * piece of text becomes a text node, so model output can never become HTML.
 */
/** Splits one paragraph into text, `strong` and `code` nodes. */
function inlineNodes(text: string): Node[] {
  return text
    .split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)
    .filter(Boolean)
    .map((part) => {
      const tag = part.startsWith("**") && part.endsWith("**") && part.length > 4 ? "strong" : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? "code" : null;
      if (!tag) return document.createTextNode(part);
      const element = document.createElement(tag);
      element.textContent = tag === "strong" ? part.slice(2, -2) : part.slice(1, -1);
      return element;
    });
}

/** Replaces the target's content with one paragraph per non-empty line. */
export function renderRichText(target: HTMLElement, text: string): void {
  const paragraphs = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const paragraph = document.createElement("p");
      paragraph.append(...inlineNodes(line));
      return paragraph;
    });
  target.replaceChildren(...paragraphs);
}
