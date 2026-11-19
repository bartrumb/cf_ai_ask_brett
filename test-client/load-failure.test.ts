import { describe, expect, it, vi } from "vitest";
import html from "../public/index.html?raw";
import { renderRichText } from "../client/rich-text";

vi.mock("agents/client", () => ({ AgentClient: class extends EventTarget {} }));
vi.mock("../client/voice", () => ({ startRecording: vi.fn(), playAudio: vi.fn(), stopPlayback: vi.fn() }));

describe("page resilience", () => {
  it("shows a clear error when the profile cannot load and storage is blocked", async () => {
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>|<link[^>]*>/g, "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const blocked = () => { throw new Error("blocked"); };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    const { conversationId } = await import("../client/main");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById("load-error")?.hidden).toBe(false);
    expect(conversationId()).toMatch(/^[a-f0-9]{32}$/);
    expect(conversationId()).not.toBe(conversationId());
    document.getElementById("theme-toggle")?.click();
    expect(document.documentElement.dataset.theme).toBeTruthy();
  });
});

describe("rich text", () => {
  it("renders paragraphs, bold and code as nodes only", () => {
    const target = document.createElement("div");
    renderRichText(target, "One **two** `three`\n\n<script>alert(1)</script> ** ``");
    expect(target.querySelectorAll("p")).toHaveLength(2);
    expect(target.querySelector("strong")?.textContent).toBe("two");
    expect(target.querySelector("code")?.textContent).toBe("three");
    expect(target.querySelector("script")).toBeNull();
    expect(target.textContent).toContain("<script>");
  });

  it("shows headings as bold text without their markers", () => {
    const target = document.createElement("div");
    renderRichText(target, "## 1. **Shepherd**\nBody");
    expect(target.querySelector("strong")?.textContent).toBe("1. Shepherd");
    expect(target.textContent).not.toContain("#");
  });
});
