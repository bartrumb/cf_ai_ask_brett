import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ShowcaseState, Snapshot } from "../src/domain/types";

interface CallOptions {
  timeout?: number;
  stream?: { onChunk?: (chunk: unknown) => void };
}
interface FakeClient extends EventTarget {
  options: { agent: string; name: string; host: string; protocol: string; onStateUpdate: (state: ShowcaseState) => void };
  call: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  clients: [] as unknown[],
  respond: (_method: string, _args: unknown[], _options?: CallOptions): unknown => undefined,
  startRecording: vi.fn(),
  startSpeech: vi.fn(),
  stopPlayback: vi.fn(),
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
vi.mock("../client/voice", () => ({ startRecording: mocks.startRecording, startSpeech: mocks.startSpeech, stopPlayback: mocks.stopPlayback }));

const HOSTILE = '<img src=x onerror="alert(1)"> **bold**';
const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const client = () => mocks.clients.at(-1) as FakeClient;
const callsTo = (method: string) => client().call.mock.calls.filter(([name]) => name === method);
const q = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const answer = (id: number, text = HOSTILE): ChatMessage => ({ id, role: "assistant", text, source: "workers-ai", createdAt: 1 });

let messages: ChatMessage[];
let responses: Record<string, unknown>;
let speakParts: unknown[];
let revision = 0;
const publish = async (activeQuestion: ShowcaseState["activeQuestion"] = null) => {
  revision += 1;
  client().options.onStateUpdate({ revision, activeQuestion });
  await flush();
};
const setInput = (value: string) => {
  const input = q<HTMLTextAreaElement>(".ask-composer textarea");
  input.value = value;
  input.dispatchEvent(new Event("input"));
};

const stored = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });

let widget: typeof import("../client/widget");

beforeEach(async () => {
  vi.resetModules();
  mocks.clients.length = 0;
  mocks.startRecording.mockReset();
  mocks.startSpeech.mockReset();
  mocks.stopPlayback.mockReset();
  stored.clear();
  messages = [];
  responses = {};
  speakParts = [];
  mocks.respond = (method, _args, options) => {
    if (method === "getSnapshot") return { offline: false, messages } satisfies Snapshot;
    if (method === "speak") for (const part of speakParts) options?.stream?.onChunk?.(part);
    const value = responses[method];
    if (value instanceof Error) throw value;
    return value;
  };
  document.body.innerHTML = `<section><div data-ask-widget data-questions='["Has he shipped AI?", 7, "", "What role does he want?"]' data-empty-text="Ask me"></div></section>`;
  widget = await import("../client/widget");
  await flush();
  client().dispatchEvent(new Event("open"));
  await flush();
});

describe("mounting", () => {
  it("mounts once, connects to the page's own host and keeps only valid suggestions", () => {
    expect(mocks.clients).toHaveLength(1);
    expect(client().options).toMatchObject({ agent: "ShowcaseAgent", host: location.host });
    expect(client().options.name).toMatch(/^[a-f0-9]{32}$/);
    expect(stored.get(widget.CONVERSATION_KEY)).toBe(client().options.name);
    const buttons = [...document.querySelectorAll(".ask-suggestions button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Has he shipped AI?", "What role does he want?"]);
    expect(q(".ask-status").textContent).toBe("Ready for questions");
    expect(q(".ask-empty").textContent).toBe("Ask me");
    expect(widget.mountAll()).toBe(0);
    expect(q<HTMLLabelElement>(".ask-composer label").htmlFor).toBe(q(".ask-composer textarea").id);
  });

  it("reuses a stored conversation ID and ignores malformed question data", () => {
    stored.set(widget.CONVERSATION_KEY, "a".repeat(32));
    expect(widget.conversationId()).toBe("a".repeat(32));
    expect(widget.parseQuestions("{not json")).toEqual([]);
    expect(widget.parseQuestions('{"a":1}')).toEqual([]);
    expect(widget.parseQuestions(JSON.stringify(Array.from({ length: 12 }, (_, index) => `Q${index}`)))).toHaveLength(8);
  });

  it("closes the connection and audio on destroy", () => {
    const host = document.createElement("div");
    const handle = widget.mountAskWidget(host, { questions: [] });
    handle.destroy();
    expect(client().close).toHaveBeenCalled();
    expect(mocks.stopPlayback).toHaveBeenCalled();
  });
});

describe("conversation", () => {
  it("renders hostile answer text without creating markup", async () => {
    messages = [{ id: 1, role: "user", text: HOSTILE, source: null, createdAt: 1 }, answer(2)];
    await publish();
    expect(document.querySelector(".ask-log img")).toBeNull();
    expect(q(".ask-user").textContent).toBe(HOSTILE);
    expect(q(".ask-answer strong").textContent).toBe("bold");
    expect(q(".ask-foot").textContent).toContain("AI-generated");
  });

  it("asks a suggested question and clears the composer on success", async () => {
    responses.ask = { ok: true };
    q<HTMLButtonElement>(".ask-suggestions button").click();
    await flush();
    expect(callsTo("ask")[0]?.[1]?.[0]).toMatchObject({ question: "Has he shipped AI?" });
  });

  it("keeps a failed send and reuses its request ID on retry", async () => {
    responses.ask = new Error("dropped");
    setInput("What is his Azure depth?");
    q<HTMLFormElement>(".ask-composer").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(q(".ask-notice").textContent).toMatch(/connection dropped/);
    expect(q<HTMLTextAreaElement>(".ask-composer textarea").value).toBe("What is his Azure depth?");
    responses.ask = { ok: false, error: "Daily limit reached." };
    q<HTMLTextAreaElement>(".ask-composer textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    const [first, second] = callsTo("ask").map((call) => call[1][0].requestId);
    expect(second).toBe(first);
    expect(q(".ask-notice").textContent).toBe("Daily limit reached.");
  });

  it("blocks oversized questions and shows streamed text while answering", async () => {
    setInput("x".repeat(501));
    expect(q<HTMLButtonElement>(".ask-send").disabled).toBe(true);
    expect(q(".ask-count").classList.contains("over")).toBe(true);
    await publish({ id: "q1", question: "Hi", startedAt: 1 } as unknown as ShowcaseState["activeQuestion"]);
    client().dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "answer-delta", delta: "Part **one**" }) }));
    expect(q(".ask-answer[aria-busy] strong").textContent).toBe("one");
    client().dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "answer-reset" }) }));
    client().dispatchEvent(Object.assign(new Event("message"), { data: '{"type":"answer-delta", broken' }));
    expect(q<HTMLButtonElement>(".ask-send").textContent).toBe("Answering");
  });

  it("shows reconnecting when the socket closes", async () => {
    client().dispatchEvent(new Event("close"));
    expect(q<HTMLElement>(".ask-status").dataset.state).toBe("connecting");
    expect(q<HTMLButtonElement>(".ask-suggestions button").disabled).toBe(true);
  });
});

describe("voice", () => {
  it("puts a transcript in the composer", async () => {
    mocks.startRecording.mockResolvedValue({ stop: vi.fn(), result: Promise.resolve("UklGRg==") });
    responses.transcribe = { ok: true, text: "Tell me about Shepherd", source: "workers-ai" };
    q<HTMLButtonElement>(".ask-mic").click();
    await flush();
    expect(q<HTMLTextAreaElement>(".ask-composer textarea").value).toBe("Tell me about Shepherd");
  });

  it("reports a blocked microphone and empty transcripts", async () => {
    mocks.startRecording.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    q<HTMLButtonElement>(".ask-mic").click();
    await flush();
    expect(q(".ask-notice").textContent).toBe("Microphone access was blocked.");
    mocks.startRecording.mockResolvedValue({ stop: vi.fn(), result: Promise.resolve("UklGRg==") });
    responses.transcribe = { ok: true, text: "", source: "workers-ai" };
    q<HTMLButtonElement>(".ask-mic").click();
    await flush();
    expect(q(".ask-notice").textContent).toBe("No speech was detected.");
  });

  it("streams spoken parts into the player and stops on a second click", async () => {
    const player = { add: vi.fn(), finish: vi.fn(), stop: vi.fn() };
    mocks.startSpeech.mockReturnValue(player);
    messages = [answer(5, "Short answer")];
    await publish();
    speakParts = [{ audio: "AAA=", mimeType: "audio/mpeg", source: "workers-ai" }];
    responses.speak = { ok: true, parts: 1 };
    q<HTMLButtonElement>(".ask-listen").click();
    await flush();
    expect(player.add).toHaveBeenCalledWith("AAA=", "audio/mpeg");
    expect(player.finish).toHaveBeenCalled();
    q<HTMLButtonElement>(".ask-listen").click();
    await flush();
    expect(mocks.stopPlayback).toHaveBeenCalled();
  });

  it("reports speech that fails", async () => {
    const player = { add: vi.fn(), finish: vi.fn(), stop: vi.fn() };
    mocks.startSpeech.mockReturnValue(player);
    messages = [answer(6, "Short answer")];
    await publish();
    responses.speak = { ok: false, error: "Voice is busy." };
    q<HTMLButtonElement>(".ask-listen").click();
    await flush();
    expect(player.stop).toHaveBeenCalled();
    expect(q(".ask-notice").textContent).toBe("Voice is busy.");
  });
});
