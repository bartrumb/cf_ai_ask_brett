import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../client/index.template.html?raw";
import site from "../content/site.example.json";
import type { ChatMessage, ShowcaseState, Snapshot } from "../src/domain/types";

interface FakeClient extends EventTarget {
  options: { agent: string; name: string; onStateUpdate: (state: ShowcaseState) => void };
  call: ReturnType<typeof vi.fn>;
}

interface CallOptions {
  timeout?: number;
  stream?: { onChunk?: (chunk: unknown) => void };
}

const mocks = vi.hoisted(() => ({
  clients: [] as unknown[],
  respond: (_method: string, _args: unknown[], _options?: CallOptions): unknown => undefined,
  startRecording: vi.fn(),
  startSpeech: vi.fn(),
  stopPlayback: vi.fn(),
  dictationSupported: vi.fn(() => false),
  startDictation: vi.fn(),
  preloadDictation: vi.fn(),
}));

vi.mock("agents/client", () => ({
  AgentClient: class extends EventTarget {
    call = vi.fn(async (method: string, args: unknown[] = [], options?: CallOptions) => mocks.respond(method, args, options));
    close = vi.fn();
    constructor(public options: unknown) {
      super();
      mocks.clients.push(this);
    }
  },
}));
vi.mock("../client/voice", () => ({
  startRecording: mocks.startRecording,
  startSpeech: mocks.startSpeech,
  stopPlayback: mocks.stopPlayback,
  dictationSupported: mocks.dictationSupported,
  startDictation: mocks.startDictation,
  preloadDictation: mocks.preloadDictation,
}));

const HOSTILE = '<img src=x onerror="alert(1)"> **bold** and `code`';
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const client = () => mocks.clients.at(-1) as FakeClient;
const callsTo = (method: string) => client().call.mock.calls.filter(([name]) => name === method);
const emit = (data: unknown) => client().dispatchEvent(Object.assign(new Event("message"), { data: typeof data === "string" ? data : JSON.stringify(data) }));
const setInput = (value: string) => {
  const input = byId<HTMLTextAreaElement>("question");
  input.value = value;
  input.dispatchEvent(new Event("input"));
};
const submit = async () => { byId("ask-form").dispatchEvent(new Event("submit", { cancelable: true })); await flush(); };
const notice = () => byId("notice").textContent;
let responses: Record<string, unknown>;
let speakParts: unknown[] = [];
let messages: ChatMessage[];
let revision = 10;
let offline = false;
const publish = async (activeQuestion: ShowcaseState["activeQuestion"] = null) => {
  revision += 1;
  client().options.onStateUpdate({ revision, activeQuestion });
  await flush();
};
const answer = (id: number, source: ChatMessage["source"] = "workers-ai", text = HOSTILE): ChatMessage => ({ id, role: "assistant", text, source, createdAt: 1 });

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>|<link[^>]*>/g, "");
  const data = document.createElement("script");
  data.type = "application/json";
  data.id = "site-data";
  data.textContent = JSON.stringify(site);
  document.body.append(data);
  const stored = new Map<string, string>([["ask-brett-conversation", "not-valid"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  mocks.respond = (method, _args, options) => {
    if (method === "getSnapshot") return { offline, messages } satisfies Snapshot;
    if (method === "speak") for (const part of speakParts) options?.stream?.onChunk?.(part);
    const value = responses[method];
    if (value instanceof Error) throw value;
    return value;
  };
  messages = [];
  responses = {};
  await import("../client/main");
  await flush();
  client().dispatchEvent(new Event("open"));
  await flush();
});

beforeEach(async () => {
  responses = {};
  messages = [];
  offline = false;
  mocks.startRecording.mockReset();
  mocks.startSpeech.mockReset();
  mocks.dictationSupported.mockReset().mockReturnValue(false);
  mocks.startDictation.mockReset();
  speakParts = [];
  client().call.mockClear();
  setInput("");
  await publish();
  byId("notice").hidden = true;
  byId("notice").textContent = "";
});

describe("profile", () => {
  it("renders site content as text with no repository or admin controls", () => {
    expect(byId("name").textContent).toBe(site.name);
    expect(document.title).toBe("Ask about Avery");
    expect(byId("stats").querySelectorAll("div")).toHaveLength(4);
    expect(byId("proof-list").children).toHaveLength(site.proof.length);
    expect(byId("project-list").children).toHaveLength(site.projects.length);
    expect(byId("skill-list").children).toHaveLength(site.skills.length);
    expect(byId("suggestions").querySelectorAll("button")).toHaveLength(8);
    expect(byId<HTMLAnchorElement>("contact-email").href).toBe(`mailto:${site.links.email}`);
    expect(document.body.textContent).not.toMatch(/repository|gateway|workers ai|standards/i);
  });

  it("uses a new private conversation ID when the stored one is invalid", () => {
    expect(client().options.agent).toBe("ShowcaseAgent");
    expect(client().options.name).toMatch(/^[a-f0-9]{32}$/);
    expect(localStorage.getItem("ask-brett-conversation")).toBe(client().options.name);
  });

  it("switches and remembers the theme", () => {
    const start = document.documentElement.dataset.theme;
    byId("theme-toggle").click();
    expect(document.documentElement.dataset.theme).not.toBe(start);
    expect(localStorage.getItem("ask-brett-theme")).toBe(document.documentElement.dataset.theme);
    byId("theme-toggle").click();
    expect(document.documentElement.dataset.theme).toBe(start);
  });
});

describe("conversation", () => {
  it("renders hostile answer text without creating markup", async () => {
    messages = [{ id: 1, role: "user", text: HOSTILE, source: null, createdAt: 1 }, answer(2)];
    await publish();
    const log = byId("conversation");
    expect(log.querySelector("img")).toBeNull();
    expect(log.querySelector("strong")?.textContent).toBe("bold");
    expect(log.querySelector("code")?.textContent).toBe("code");
    expect(log.querySelector(".message.user")?.textContent).toBe(HOSTILE);
    expect(log.textContent).toContain("AI-generated");
  });

  it("labels offline, fixed and failed answers", async () => {
    offline = true;
    messages = [answer(1, "offline"), answer(2, "guarded"), answer(3, "unavailable")];
    await publish();
    const text = byId("conversation").textContent;
    expect(text).toContain("Offline preview");
    expect(text).toContain("Standard reply");
    expect(text).toContain("Not answered");
    expect(byId("conversation").querySelectorAll(".listen")).toHaveLength(2);
    expect(byId("disclaimer").textContent).toContain("no AI model");
  });

  it("sends a question, clears the composer and sends an ID", async () => {
    responses.ask = { ok: true, submissionId: "s", accepted: true };
    setInput("  What was built?  ");
    expect(byId<HTMLButtonElement>("send").disabled).toBe(false);
    await submit();
    const [, [payload]] = callsTo("ask")[0] as [string, [{ question: string; requestId: string }]];
    expect(payload.question).toBe("What was built?");
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(byId<HTMLTextAreaElement>("question").value).toBe("");
  });

  it("sends suggested questions and Enter, but not Shift+Enter", async () => {
    responses.ask = { ok: true, submissionId: "s", accepted: true };
    byId("suggestions").querySelector("button")?.click();
    await flush();
    expect((callsTo("ask")[0]?.[1] as [{ question: string }])[0].question).toBe(site.questions[0]);
    setInput("Line");
    byId("question").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    await flush();
    expect(callsTo("ask")).toHaveLength(1);
    byId("question").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await flush();
    expect(callsTo("ask")).toHaveLength(2);
  });

  it("shows server errors and keeps the question", async () => {
    responses.ask = { ok: false, error: "Limit reached." };
    setInput("Keep me");
    await submit();
    expect(notice()).toBe("Limit reached.");
    expect(byId<HTMLTextAreaElement>("question").value).toBe("Keep me");
  });

  it("reuses the request ID when retrying after a dropped connection", async () => {
    responses.ask = new Error("socket closed");
    setInput("Retry me");
    await submit();
    expect(notice()).toContain("connection dropped");
    responses.ask = { ok: true, submissionId: "s", accepted: false };
    await submit();
    const ids = callsTo("ask").map(([, args]) => (args as [{ requestId: string }])[0].requestId);
    expect(ids[0]).toBe(ids[1]);
  });

  it("shows loading, streams safely, ignores other frames and blocks a second question", async () => {
    await publish({ submissionId: "s" });
    expect(byId("conversation").querySelector(".thinking")).not.toBeNull();
    expect(byId<HTMLButtonElement>("send").textContent).toBe("Answering");
    setInput("Another");
    await submit();
    expect(callsTo("ask")).toHaveLength(0);
    emit({ type: "answer-delta", delta: "Hello <b>there</b> **now**" });
    emit("{not json answer-delta");
    emit({ type: "other", text: "answer-delta" });
    expect(byId("pending-answer").querySelector("b")).toBeNull();
    expect(byId("pending-answer").querySelector("strong")?.textContent).toBe("now");
    emit({ type: "answer-reset" });
    client().options.onStateUpdate({ revision, activeQuestion: { submissionId: "s" } });
    expect(byId("pending-answer").textContent).toContain("Thinking");
  });

  it("disables asking while disconnected and recovers on reconnect", async () => {
    setInput("Hello");
    client().dispatchEvent(new Event("close"));
    expect(byId("connection").textContent).toBe("Reconnecting");
    expect(byId<HTMLButtonElement>("send").disabled).toBe(true);
    client().dispatchEvent(new Event("open"));
    await flush();
    expect(byId<HTMLButtonElement>("send").disabled).toBe(false);
  });

  it("reports snapshot failures", async () => {
    const original = mocks.respond;
    mocks.respond = () => { throw new Error("internal detail"); };
    await publish();
    mocks.respond = original;
    expect(notice()).toBe("Something went wrong. Please try again.");
  });
});

describe("voice", () => {
  const recordingWith = (audio = "AAAA") => ({ stop: vi.fn(), result: Promise.resolve(audio) });

  it("places a transcript in the composer for checking", async () => {
    mocks.startRecording.mockResolvedValue(recordingWith());
    responses.transcribe = { ok: true, text: "Spoken words", source: "offline" };
    setInput("Start");
    byId("mic").click();
    await flush();
    expect(byId<HTMLTextAreaElement>("question").value).toBe("Start Spoken words");
    expect(notice()).toContain("sample transcript");
    expect(callsTo("ask")).toHaveLength(0);
  });

  it("stops an active recording on the second press", async () => {
    let finish = (_value: string) => {};
    const recording = { stop: vi.fn(() => finish("AAAA")), result: new Promise<string>((resolve) => { finish = resolve; }) };
    mocks.startRecording.mockResolvedValue(recording);
    responses.transcribe = { ok: true, text: "", source: "workers-ai" };
    byId("mic").click();
    await flush();
    expect(byId("mic").getAttribute("aria-pressed")).toBe("true");
    byId("mic").click();
    await flush();
    expect(recording.stop).toHaveBeenCalled();
    expect(notice()).toBe("No speech was detected.");
  });

  it.each([
    ["blocked microphones", () => mocks.startRecording.mockRejectedValue(new DOMException("no", "NotAllowedError")), "Microphone access was blocked. You can allow it in the browser's site settings."],
    ["missing microphones", () => mocks.startRecording.mockRejectedValue(new DOMException("no", "NotFoundError")), "No microphone was found."],
    ["microphones in use", () => mocks.startRecording.mockRejectedValue(new DOMException("no", "NotReadableError")), "The microphone is in use by another app."],
    ["recording failures", () => mocks.startRecording.mockRejectedValue(new Error("x")), "The recording could not be processed."],
    ["server errors", () => { mocks.startRecording.mockResolvedValue(recordingWith()); responses.transcribe = { ok: false, error: "Unavailable." }; }, "Unavailable."],
  ])("reports %s", async (_name, arrange, expected) => {
    arrange();
    byId("mic").click();
    await flush();
    expect(notice()).toBe(expected);
  });

  it("shows live dictation in the composer and stops on a second click", async () => {
    mocks.dictationSupported.mockReturnValue(true);
    let finishTurn: (text: string) => void = () => {};
    let speak: (text: string) => void = () => {};
    let level: (value: number) => void = () => {};
    const stop = vi.fn();
    mocks.startDictation.mockImplementation((url: string, worklet: string, onText: (text: string) => void, options: { onLevel: (value: number) => void }) => {
      expect(url).toBe(`ws://${location.host}/agents/dictation`);
      expect(worklet).toBe("/capture-processor.js");
      speak = onText;
      level = options.onLevel;
      return { ready: Promise.resolve(), result: new Promise<string>((resolve) => { finishTurn = resolve; }), stop };
    });
    const box = byId<HTMLTextAreaElement>("question");
    const mic = byId<HTMLButtonElement>("mic");
    setInput("Hi.");
    mic.click();
    expect(mocks.startDictation).toHaveBeenCalledTimes(1);
    expect(box.placeholder).toBe("Listening…");
    expect(mic.textContent).toBe("Stop");
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.classList.contains("listening")).toBe(true);
    level(0.5);
    expect(mic.style.getPropertyValue("--level")).toBe("0.50");
    await flush();
    speak("Tell me");
    speak("Tell me about Shepherd");
    expect(box.value).toBe("Hi. Tell me about Shepherd");
    expect(box.selectionStart).toBe(box.value.length);
    expect(box.placeholder).not.toBe("Listening…");
    expect(byId<HTMLButtonElement>("send").disabled).toBe(false);
    mic.click();
    expect(stop).toHaveBeenCalled();
    finishTurn("Tell me about Shepherd");
    await flush();
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(mic.classList.contains("listening")).toBe(false);
    expect(mic.style.getPropertyValue("--level")).toBe("");
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(callsTo("ask")).toHaveLength(0);
  });

  it("falls back to recording when live dictation cannot connect, and explains a blocked microphone", async () => {
    mocks.dictationSupported.mockReturnValue(true);
    mocks.startDictation.mockReturnValue({ ready: Promise.reject(new Error("refused")), result: new Promise(() => {}), stop: vi.fn() });
    mocks.startRecording.mockResolvedValue(recordingWith());
    responses.transcribe = { ok: true, text: "Fallback words", source: "workers-ai" };
    byId("mic").click();
    await flush();
    await flush();
    expect(byId<HTMLTextAreaElement>("question").value).toBe("Fallback words");
    mocks.startDictation.mockReturnValue({ ready: Promise.reject(new DOMException("no", "NotAllowedError")), result: new Promise(() => {}), stop: vi.fn() });
    mocks.startRecording.mockClear();
    byId("mic").click();
    await flush();
    expect(notice()).toContain("Microphone access was blocked");
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(byId("mic").getAttribute("aria-pressed")).toBe("false");
  });

  it("preloads the dictation worklet once the composer or microphone is approached", () => {
    byId("mic").dispatchEvent(new Event("pointerenter"));
    byId("question").dispatchEvent(new Event("focus"));
    expect(mocks.preloadDictation).toHaveBeenCalledWith("/capture-processor.js");
  });

  const listen = async () => {
    messages = [answer(7)];
    await publish();
    (byId("conversation").querySelector(".listen") as HTMLElement).click();
    await flush();
  };

  /** A fake player that records calls and exposes the handlers main.ts gave it. */
  const fakePlayer = () => {
    const player = { add: vi.fn(), finish: vi.fn(), stop: vi.fn(), handlers: null as null | Record<"onStart" | "onEnd" | "onError", () => void> };
    mocks.startSpeech.mockImplementation((handlers) => {
      player.handlers = handlers;
      return player;
    });
    return player;
  };
  const button = () => byId("conversation").querySelector(".listen") as HTMLElement;
  const part = (source = "workers-ai") => ({ index: 0, audio: "AAAA", mimeType: "audio/mpeg", source, model: null });

  it("streams parts to the player and can stop it", async () => {
    const player = fakePlayer();
    speakParts = [part("offline"), part("offline")];
    responses.speak = { ok: true, parts: 2 };
    await listen();
    expect(callsTo("speak")[0]?.[1]).toEqual([{ messageId: 7 }]);
    expect(callsTo("speak")[0]?.[2]).toMatchObject({ timeout: 60_000 });
    expect(player.add).toHaveBeenCalledTimes(2);
    expect(player.add).toHaveBeenCalledWith("AAAA", "audio/mpeg");
    expect(player.finish).toHaveBeenCalled();
    expect(notice()).toContain("test tone");
    expect(button().textContent).toBe("Preparing audio");
    player.handlers?.onStart();
    expect(button().textContent).toBe("Stop");
    button().click();
    await flush();
    expect(mocks.stopPlayback).toHaveBeenCalled();
    expect(button().textContent).toBe("Listen");
  });

  it("resets when playback ends", async () => {
    const player = fakePlayer();
    speakParts = [part()];
    responses.speak = { ok: true, parts: 1 };
    await listen();
    player.handlers?.onStart();
    player.handlers?.onEnd();
    expect(button().textContent).toBe("Listen");
  });

  it("reports speech errors and playback failures", async () => {
    let player = fakePlayer();
    responses.speak = { ok: false, error: "Speech is unavailable right now." };
    await listen();
    expect(notice()).toBe("Speech is unavailable right now.");
    expect(player.stop).toHaveBeenCalled();
    player = fakePlayer();
    speakParts = [part()];
    responses.speak = { ok: true, parts: 1 };
    await listen();
    player.handlers?.onError();
    expect(notice()).toBe("Audio could not be played.");
    expect(button().textContent).toBe("Listen");
    player = fakePlayer();
    responses.speak = new Error("socket closed");
    await listen();
    expect(notice()).toBe("Audio could not be played.");
    expect(player.stop).toHaveBeenCalled();
  });
});
