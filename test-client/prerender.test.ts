import { describe, expect, it } from "vitest";
import page from "../public/index.html?raw";
import site from "../public/site.json";

describe("built page", () => {
  const parsed = new DOMParser().parseFromString(page, "text/html");

  it("contains the profile before any script runs", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(parsed.getElementById("name")?.textContent).toBe(site.name);
    expect(parsed.getElementById("proof-list")?.children).toHaveLength(site.proof.length);
    expect(parsed.getElementById("disclaimer")?.textContent).toContain(site.links.email);
    expect(page).not.toContain("Loading profile");
  });

  it("keeps suggestions disabled until the conversation connects", () => {
    const buttons = [...(parsed.getElementById("suggestions")?.querySelectorAll("button") ?? [])];
    expect(buttons).toHaveLength(site.questions.length);
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it("embeds the profile as data that cannot close its script element", () => {
    const data = /<script type="application\/json" id="site-data">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(JSON.parse(data)).toEqual(site);
    expect(data).not.toContain("<");
  });

  it("still loads the application script", () => {
    expect(page).toContain('<script type="module" src="/app.js"></script>');
  });
});
