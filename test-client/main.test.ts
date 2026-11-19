import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../public/index.html?raw";
import type { GuardState, ReviewRecord, RuleResult, Snapshot } from "../src/domain/types";

interface FakeClient extends EventTarget {
  options: { name: string; onStateUpdate: (state: GuardState) => void };
  call: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  clients: [] as unknown[],
  respond: (_method: string, _args: unknown[]): unknown => undefined,
  recording: { stop: () => {}, result: Promise.resolve("audio") },
  startRecording: vi.fn(),
  playAudio: vi.fn(),
  stopPlayback: vi.fn(),
}));

vi.mock("agents/client", () => ({
  AgentClient: class extends EventTarget {
    call = vi.fn(async (method: string, args: unknown[] = []) => mocks.respond(method, args));
    close = vi.fn();
    constructor(public options: unknown) {
      super();
      mocks.clients.push(this);
    }
  },
}));

vi.mock("../client/voice", () => ({
  startRecording: mocks.startRecording,
  playAudio: mocks.playAudio,
  stopPlayback: mocks.stopPlayback,
}));

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const result: RuleResult = {
  kind: "diff",
  risk: "high",
  riskBeforeExceptions: "high",
  applicableStandards: ["STD-SEC-02"],
  stats: { files: 1, additions: 1, deletions: 0 },
  notes: ["A rule note"],
  findings: [
    { id: "F1", standardId: "STD-SEC-02", standardTitle: "No open ingress", severity: "high", path: "infra/n.tf", line: 3, evidence: "<img src=x onerror=alert(1)>", occurrences: 2, waivable: true, status: "open", exceptionId: null },
    { id: "F2", standardId: "STD-SEC-01", standardTitle: "No credentials", severity: "critical", path: "a.yml", line: null, evidence: "", occurrences: 1, waivable: false, status: "open", exceptionId: null },
    { id: "F3", standardId: "STD-OBS-01", standardTitle: "No debug", severity: "low", path: "b.ts", line: 1, evidence: "x", occurrences: 1, waivable: true, status: "excepted", exceptionId: "e1" },
  ],
};
const review: ReviewRecord = {
  id: REVIEW_ID, createdAt: 1, status: "complete", title: "infra/n.tf", result,
  commentary: "### F1 · STD-SEC-02\nWhy it matters: Open.\nSuggested fix: Close it.\n```\ncode\n```\nPlain line",
  commentarySource: "workers-ai", commentaryModel: "@cf/test/model", commentaryWarnings: ["Check this"], error: null,
};
const snapshot = (): Snapshot => ({
  repository: "repo",
  routing: { offline: false, gatewayId: "gw", models: [{ label: "Language model", primary: "@cf/a", secondary: "@cf/b" }] },
  standards: [
    { id: "STD-SEC-02", title: "No open ingress", summary: "s", guidance: "g", severity: "high", waivable: true, enabled: true },
    { id: "STD-SEC-01", title: "No credentials", summary: "s", guidance: "g", severity: "critical", waivable: false, enabled: true },
  ],
  exceptions: [{ id: "e1", standardId: "STD-OBS-01", path: "b.ts", reason: "Approved reason", reviewId: REVIEW_ID, createdAt: 1 }],
  reviews: [review, { ...review, id: "pending", status: "running", title: "running", result: null, commentary: "", commentarySource: null, commentaryWarnings: [] }, { ...review, id: "failed", status: "failed", title: "failed", result: null, error: "It failed" }],
  messages: [
    { id: 1, role: "user", kind: "review", text: "diff", reviewId: REVIEW_ID, source: null, model: null, createdAt: 1 },
    { id: 2, role: "user", kind: "review", text: "running", reviewId: "pending", source: null, model: null, createdAt: 1 },
    { id: 3, role: "user", kind: "review", text: "failed", reviewId: "failed", source: null, model: null, createdAt: 1 },
    { id: 4, role: "user", kind: "text", text: "Question?", reviewId: null, source: null, model: null, createdAt: 2 },
    { id: 5, role: "assistant", kind: "text", text: "Answer", reviewId: null, source: "offline", model: null, createdAt: 3 },
  ],
});

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const latest = () => mocks.clients.at(-1) as FakeClient;
const emit = (data: unknown) => latest().dispatchEvent(Object.assign(new Event("message"), { data: typeof data === "string" ? data : JSON.stringify(data) }));
const setInput = (value: string) => {
  const input = byId<HTMLTextAreaElement>("change-input");
  input.value = value;
  input.dispatchEvent(new Event("input"));
};
const idle: GuardState = { revision: 1, active: null, activeQuestion: null };
let responses: Record<string, unknown>;

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>|<link[^>]*>/g, "");
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  Element.prototype.scrollIntoView ??= () => {};
  mocks.respond = (method) => (method === "getSnapshot" ? snapshot() : responses[method]);
  history.replaceState(null, "", "/?repo=Sample%20Repo");
  await import("../client/main");
});

beforeEach(async () => {
  responses = {};
  mocks.startRecording.mockReset();
  mocks.playAudio.mockReset();
  byId("repo-input");
  setInput("");
  byId<HTMLInputElement>("repo-input").value = "repo";
  byId<HTMLFormElement>("repo-form").dispatchEvent(new Event("submit", { cancelable: true }));
  latest().dispatchEvent(new Event("open"));
  latest().options.onStateUpdate(idle);
  await flush();
});

describe("chat page", () => {
  it("normalizes the repository name and shows a connected state", () => {
    expect((mocks.clients[0] as FakeClient).options.name).toBe("sample-repo");
    expect(byId("connection").textContent).toBe("Connected");
    latest().dispatchEvent(new Event("close"));
    expect(byId("connection").textContent).toBe("Reconnecting");
  });

  it("renders rule results and commentary separately, with submitted text inert", () => {
    expect(document.querySelector(".panel.rules .risk")?.textContent).toBe("high risk");
    expect(document.querySelector(".panel.ai")?.textContent).toContain("via AI Gateway gw");
    expect(document.querySelector(".evidence")?.textContent).toContain("<img");
    expect(document.querySelector(".evidence img")).toBeNull();
    expect(document.querySelector(".commentary pre")?.textContent).toContain("code");
    expect(document.body.textContent).toContain("Cannot be waived");
    expect(document.body.textContent).toContain("Exception applied: Approved reason");
    expect(document.body.textContent).toContain("It failed");
    expect(byId("routing").textContent).toContain("All calls use AI Gateway: gw");
  });

  it("submits a review with an idempotent request ID", async () => {
    responses.startReview = { ok: true, reviewId: REVIEW_ID };
    (document.querySelector(".chip") as HTMLButtonElement).click();
    byId("review-button").click();
    await flush();
    const [, args] = latest().call.mock.calls.find(([method]) => method === "startReview") as [string, [{ text: string; requestId: string }]];
    expect(args[0].text).toContain("infra/network.tf");
    expect(args[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(byId<HTMLTextAreaElement>("change-input").value).toBe("");
  });

  it("shows server errors and blocks oversized input", async () => {
    responses.startReview = { ok: false, error: "Malformed diff" };
    setInput("change");
    byId("change-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    await flush();
    expect(byId("notice").textContent).toBe("Malformed diff");
    setInput("x".repeat(40_001));
    expect(byId<HTMLButtonElement>("review-button").disabled).toBe(true);
    expect(byId("char-count").classList.contains("over")).toBe(true);
  });

  it("reports failed calls", async () => {
    latest().call.mockRejectedValueOnce(new Error("Socket closed"));
    setInput("change");
    byId("review-button").click();
    await flush();
    expect(byId("notice").textContent).toBe("Socket closed");
  });

  it("shows live review progress and streamed commentary", async () => {
    latest().options.onStateUpdate({ revision: 1, activeQuestion: null, active: { reviewId: "pending", steps: { intake: "complete", rules: "complete", commentary: "running", save: "pending" } } });
    await flush();
    expect(document.querySelector(".step.running")?.textContent).toBe("AI commentary");
    emit({ type: "commentary-reset", reviewId: "pending" });
    emit({ type: "commentary-delta", reviewId: REVIEW_ID, delta: "Streaming" });
    expect(document.querySelector(`[data-commentary="${REVIEW_ID}"]`)?.textContent).toBe("Streaming");
    emit("not json commentary-delta");
    emit('{"type":"commentary-delta"');
  });

  it("submits durable questions and shows the streaming answer", async () => {
    responses.ask = { ok: true, submissionId: "s1", accepted: true };
    setInput("  What is open?  ");
    byId("ask-button").click();
    await flush();
    const [, args] = latest().call.mock.calls.find(([method]) => method === "ask") as [string, [{ question: string }]];
    expect(args[0].question).toBe("What is open?");
    latest().options.onStateUpdate({ ...idle, revision: 2, activeQuestion: { submissionId: "s1" } });
    await flush();
    expect(byId("pending-answer").textContent).toContain("Thinking");
    emit({ type: "answer-reset" });
    emit({ type: "answer-delta", delta: "Two findings" });
    expect(byId("pending-answer").textContent).toContain("Two findings");
    expect(byId<HTMLButtonElement>("review-button").disabled).toBe(true);
  });

  it("shows question errors", async () => {
    responses.ask = { ok: false, error: "Busy" };
    setInput("Question");
    byId("ask-button").click();
    await flush();
    expect(byId("notice").textContent).toBe("Busy");
    latest().call.mockRejectedValueOnce("offline");
    setInput("Question");
    byId("ask-button").click();
    await flush();
    expect(byId("notice").textContent).toBe("Something went wrong.");
  });

  it("records an exception through the dialog", async () => {
    responses.acceptException = { ok: false, error: "Too short" };
    (document.querySelector(".finding-action .link-button") as HTMLButtonElement).click();
    expect(byId("exception-target").textContent).toBe("STD-SEC-02 on infra/n.tf");
    byId<HTMLTextAreaElement>("exception-reason").value = "short";
    byId("exception-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(byId("exception-error").textContent).toBe("Too short");
    latest().call.mockRejectedValueOnce(new Error("Lost connection"));
    byId("exception-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(byId("exception-error").textContent).toBe("Lost connection");
    responses.acceptException = { ok: true };
    byId("exception-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(byId<HTMLDialogElement>("exception-dialog").hasAttribute("open")).toBe(false);
    byId("exception-cancel").click();
  });

  it("updates standards and exceptions and navigates history", async () => {
    responses.setStandardEnabled = { ok: false, error: "Mandatory" };
    responses.revokeException = { ok: true };
    const checkbox = document.querySelector<HTMLInputElement>(".standard input") as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    await flush();
    expect(byId("notice").textContent).toBe("Mandatory");
    (document.querySelector(".exception .link-button") as HTMLButtonElement).click();
    await flush();
    expect(latest().call).toHaveBeenCalledWith("revokeException", [{ id: "e1" }]);
    latest().call.mockRejectedValueOnce(new Error("Failed action"));
    (document.querySelector(".exception .link-button") as HTMLButtonElement).click();
    await flush();
    expect(byId("notice").textContent).toBe("Failed action");
    (document.querySelector(".history-item") as HTMLButtonElement).click();
  });

  it("refetches on a new revision and rejects an empty repository name", async () => {
    const calls = latest().call.mock.calls.length;
    latest().options.onStateUpdate({ ...idle, revision: 5 });
    await flush();
    expect(latest().call.mock.calls.length).toBeGreaterThan(calls);
    byId<HTMLInputElement>("repo-input").value = "///";
    byId("repo-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(byId("notice").textContent).toContain("Enter a repository name");
  });
});

describe("voice controls", () => {
  it("adds a transcript to the composer", async () => {
    responses.transcribe = { ok: true, text: "Spoken change", source: "offline" };
    let finish: (value: string) => void = () => {};
    const stop = vi.fn(() => finish("audio"));
    mocks.startRecording.mockResolvedValue({ stop, result: new Promise<string>((resolve) => { finish = resolve; }) });
    setInput("Typed");
    byId("mic-button").click();
    await flush();
    expect(byId("mic-button").textContent).toBe("Stop recording");
    byId("mic-button").click();
    await flush();
    expect(stop).toHaveBeenCalled();
    expect(byId<HTMLTextAreaElement>("change-input").value).toBe("Typed\nSpoken change");
    expect(byId("notice").textContent).toContain("sample transcript");
  });

  it.each([
    [{ ok: false, error: "Limit reached" }, "Limit reached"],
    [{ ok: true, text: "", source: "workers-ai" }, "No speech was detected."],
  ])("handles transcription result %#", async (response, message) => {
    responses.transcribe = response;
    mocks.startRecording.mockResolvedValue({ stop: () => {}, result: Promise.resolve("audio") });
    byId("mic-button").click();
    await flush();
    expect(byId("notice").textContent).toBe(message);
  });

  it("explains microphone failures", async () => {
    mocks.startRecording.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    byId("mic-button").click();
    await flush();
    expect(byId("notice").textContent).toBe("Microphone access was blocked.");
    mocks.startRecording.mockRejectedValueOnce(new Error("bad"));
    byId("mic-button").click();
    await flush();
    expect(byId("notice").textContent).toBe("The recording could not be processed.");
  });

  it("plays stored content and can stop it", async () => {
    responses.speak = { ok: true, audio: "AAAA", mimeType: "audio/mpeg", source: "offline" };
    let ended: () => void = () => {};
    mocks.playAudio.mockImplementation(async (_audio: string, _type: string, onEnd: () => void) => { ended = onEnd; });
    (document.querySelector(".panel.ai .listen") as HTMLButtonElement).click();
    await flush();
    expect(latest().call).toHaveBeenCalledWith("speak", [{ kind: "review", id: REVIEW_ID }]);
    expect(byId("notice").textContent).toContain("test tone");
    expect(document.querySelector(".panel.ai .listen")?.textContent).toBe("Stop");
    (document.querySelector(".panel.ai .listen") as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector(".panel.ai .listen")?.textContent).toBe("Listen");
    ended();
  });

  it("shows speech failures", async () => {
    responses.speak = { ok: false, error: "No speech" };
    (document.querySelector(".bubble.assistant .listen") as HTMLButtonElement).click();
    await flush();
    expect(byId("notice").textContent).toBe("No speech");
    expect(mocks.playAudio).not.toHaveBeenCalled();
  });
});
