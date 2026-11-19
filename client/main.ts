/*
 * Browser application: activates the profile built into the page, connects this browser's private
 * conversation and handles questions, voice and playback. The server validates everything, so limits
 * here only improve feedback. All dynamic text is added as text nodes.
 */
import { AgentClient } from "agents/client";
import type { SiteContent } from "../src/domain/content";
import type { ActionResult, AnswerSource, ChatMessage, LiveMessage, ShowcaseState, Snapshot, SpokenPart } from "../src/domain/types";
import { byId, disclaimerText, emptyPrompt, h, renderProfile, setText } from "./profile";
import { renderRichText } from "./rich-text";
import { startRecording, startSpeech, stopPlayback, type Recording } from "./voice";

/** Mirrors the server limit so the composer can warn before submitting. */
const MAX_QUESTION_CHARS = 500;
/** localStorage key for this browser's conversation. */
const CONVERSATION_KEY = "ask-brett-conversation";
/** localStorage key for an explicit theme choice. */
const THEME_KEY = "ask-brett-theme";
/** Backstop for a whole streamed answer. Parts play as they arrive, well before this. */
const SPEECH_CALL_TIMEOUT_MS = 60_000;
/** Labels shown under answers. */
const SOURCE_LABELS: Record<AnswerSource, string> = {
  "workers-ai": "AI-generated",
  offline: "Offline preview",
  guarded: "Standard reply",
  unavailable: "Not answered",
};

const ui = {
  conversation: byId("conversation"),
  notice: byId("notice"),
  status: byId("connection"),
  form: byId<HTMLFormElement>("ask-form"),
  input: byId<HTMLTextAreaElement>("question"),
  count: byId("count"),
  mic: byId<HTMLButtonElement>("mic"),
  send: byId<HTMLButtonElement>("send"),
  suggestions: byId("suggestions"),
  theme: byId<HTMLButtonElement>("theme-toggle"),
  disclaimer: byId("disclaimer"),
};

let client: AgentClient<unknown, ShowcaseState> | null = null;
let connected = false;
let site: SiteContent | null = null;
let snapshot: Snapshot | null = null;
let state: ShowcaseState | null = null;
let seenRevision = -1;
let liveAnswer = "";
let submitting = false;
let refreshing = false;
let refreshQueued = false;
let recording: Recording | null = null;
let transcribing = false;
/** Answer being fetched or played as speech. */
let speakingId: number | null = null;
let speechLoading = false;
/** A send whose outcome is unknown. Retrying the same text reuses its ID, so it is not charged twice. */
let unconfirmed: { question: string; requestId: string } | null = null;

/** Reads storage, which can throw under strict privacy settings. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes storage. The page works for this visit if it cannot. */
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the value simply lasts until the page closes.
  }
}

/** Returns this browser's unguessable conversation ID, creating one on first use. */
export function conversationId(): string {
  const saved = readStored(CONVERSATION_KEY);
  if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  writeStored(CONVERSATION_KEY, id);
  return id;
}

/** Shows a message in the notice area. An empty message hides it. */
function setNotice(message: string): void {
  ui.notice.textContent = message;
  ui.notice.hidden = !message;
}

/** Shows an unexpected failure without exposing internal details. */
function reportFailure(): void {
  setNotice("Something went wrong. Please try again.");
}

/** True while a question prevents another submission. */
function isBusy(): boolean {
  return Boolean(state?.activeQuestion) || submitting;
}

/** Synchronizes composer controls and suggestions with current state. */
function updateComposer(): void {
  const length = ui.input.value.length;
  ui.count.textContent = `${length} / ${MAX_QUESTION_CHARS}`;
  ui.count.classList.toggle("over", length >= MAX_QUESTION_CHARS);
  ui.send.disabled = !connected || isBusy() || !ui.input.value.trim() || length > MAX_QUESTION_CHARS;
  ui.send.textContent = isBusy() ? "Answering" : "Ask";
  ui.mic.disabled = !connected || transcribing;
  ui.mic.textContent = recording ? "Stop" : transcribing ? "Transcribing" : "Speak";
  ui.mic.setAttribute("aria-pressed", String(Boolean(recording)));
  for (const button of ui.suggestions.querySelectorAll("button")) button.disabled = !connected || isBusy();
}

/** Builds the control that starts or stops speech for an answer. */
function listenButton(id: number): HTMLElement {
  const label = speakingId === id ? (speechLoading ? "Preparing audio" : "Stop") : "Listen";
  return h("button", { class: "listen", type: "button", onClick: () => void toggleSpeech(id) }, label);
}

/** Renders one stored message. */
function messageNode(message: ChatMessage): HTMLElement {
  if (message.role === "user") return h("div", { class: "message user" }, message.text);
  const body = h("div", { class: "message-body" });
  renderRichText(body, message.text);
  return h(
    "article",
    { class: "message assistant" },
    body,
    h(
      "div",
      { class: "message-foot" },
      message.source && SOURCE_LABELS[message.source],
      message.source !== "unavailable" && listenButton(message.id),
    ),
  );
}

/** Renders the answer in progress. */
function pendingNode(): HTMLElement {
  const body = h("div", { class: "message-body", id: "pending-answer" });
  if (liveAnswer) renderRichText(body, liveAnswer);
  else body.append(h("p", { class: "thinking" }, "Thinking"));
  return h("article", { class: "message assistant", "aria-busy": "true" }, body);
}

/** Rebuilds the conversation, following the end when the reader is already there. */
function render(): void {
  const { conversation } = ui;
  const follow = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
  const nodes: Node[] = (snapshot?.messages ?? []).map(messageNode);
  if (state?.activeQuestion || submitting) nodes.push(pendingNode());
  if (nodes.length === 0) nodes.push(h("p", { class: "empty" }, emptyPrompt(site)));
  conversation.replaceChildren(...nodes);
  if (follow) conversation.scrollTop = conversation.scrollHeight;
  ui.disclaimer.textContent = snapshot?.offline
    ? "Offline preview: answers are matched from the written profile, and no AI model is used."
    : disclaimerText(site);
  updateComposer();
}

/** Fetches stored messages. Calls during a fetch collapse into one follow-up. */
async function refresh(): Promise<void> {
  if (!client) return;
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  const current = client;
  try {
    const next = (await current.call("getSnapshot")) as unknown as Snapshot;
    if (current !== client) return;
    snapshot = next;
    if (!state?.activeQuestion) liveAnswer = "";
    render();
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh().catch(reportFailure);
    }
  }
}

/** Sends a question. Its answer arrives through live messages and a later snapshot. */
async function ask(question: string): Promise<void> {
  const text = question.trim();
  if (!client || !connected || isBusy() || !text) return;
  if (text.length > MAX_QUESTION_CHARS) {
    setNotice(`Questions can be up to ${MAX_QUESTION_CHARS} characters.`);
    return;
  }
  setNotice("");
  submitting = true;
  liveAnswer = "";
  render();
  const requestId = unconfirmed?.question === text ? unconfirmed.requestId : crypto.randomUUID();
  unconfirmed = { question: text, requestId };
  try {
    const result = (await client.call("ask", [{ question: text, requestId }])) as ActionResult;
    unconfirmed = null;
    if (result.ok) ui.input.value = "";
    else setNotice(result.error);
  } catch {
    setNotice("The connection dropped. Your question was kept, so you can send it again.");
    ui.input.value = text;
  } finally {
    submitting = false;
    render();
    void refresh().catch(reportFailure);
  }
}

/** Starts recording, or stops it. The transcript goes to the composer for checking. */
async function toggleRecording(): Promise<void> {
  if (recording) {
    recording.stop();
    return;
  }
  setNotice("");
  const owner = client;
  try {
    recording = await startRecording();
    updateComposer();
    const audio = await recording.result;
    recording = null;
    transcribing = true;
    updateComposer();
    if (!owner) return;
    const result = (await owner.call("transcribe", [{ audio }])) as unknown as ActionResult<{ text: string; source: AnswerSource }>;
    if (!result.ok) setNotice(result.error);
    else if (!result.text) setNotice("No speech was detected.");
    else {
      ui.input.value = [ui.input.value.trim(), result.text].filter(Boolean).join(" ").slice(0, MAX_QUESTION_CHARS);
      ui.input.focus();
      if (result.source === "offline") setNotice("Offline preview: this is a sample transcript, not your words.");
    }
  } catch (error) {
    const denied = error instanceof DOMException && error.name === "NotAllowedError";
    setNotice(denied ? "Microphone access was blocked." : "The recording could not be processed.");
  } finally {
    recording = null;
    transcribing = false;
    updateComposer();
  }
}

/** Plays an answer, or stops it when already selected. Late responses cannot override a newer choice. */
async function toggleSpeech(id: number): Promise<void> {
  stopPlayback();
  if (speakingId === id) {
    speakingId = null;
    render();
    return;
  }
  if (!client) return;
  setNotice("");
  speakingId = id;
  speechLoading = true;
  render();
  const active = () => speakingId === id;
  const end = (message = "") => {
    if (!active()) return;
    speakingId = null;
    speechLoading = false;
    if (message) setNotice(message);
    render();
  };
  // Created before any await, so it runs inside the click that started it.
  const player = startSpeech({
    onStart: () => {
      if (!active()) return;
      speechLoading = false;
      render();
    },
    onEnd: () => end(),
    onError: () => end("Audio could not be played."),
  });
  try {
    const result = (await client.call("speak", [{ messageId: id }], {
      timeout: SPEECH_CALL_TIMEOUT_MS,
      stream: {
        onChunk: (chunk: unknown) => {
          const part = chunk as SpokenPart;
          if (!active()) return;
          if (part.source === "offline") setNotice("Offline preview: Listen plays a test tone instead of speech.");
          player.add(part.audio, part.mimeType);
        },
      },
    })) as ActionResult<{ parts: number }>;
    if (!active()) return player.stop();
    if (result.ok) player.finish();
    else {
      player.stop();
      end(result.error);
    }
  } catch {
    player.stop();
    end("Audio could not be played.");
  }
}

/** Applies streamed text directly, avoiding a full render per delta. */
function handleLiveMessage(message: LiveMessage): void {
  liveAnswer = message.type === "answer-reset" ? "" : liveAnswer + message.delta;
  const target = document.getElementById("pending-answer");
  if (target && liveAnswer) renderRichText(target, liveAnswer);
  ui.conversation.scrollTop = ui.conversation.scrollHeight;
}

/** Updates the connection indicator and the controls that depend on it. */
function setConnection(label: string, stateName: string, open: boolean): void {
  ui.status.textContent = label;
  ui.status.dataset.state = stateName;
  connected = open;
  updateComposer();
}

/** Connects to this browser's conversation. The SDK reconnects by itself. */
function connect(): void {
  const next = new AgentClient<unknown, ShowcaseState>({
    agent: "ShowcaseAgent",
    name: conversationId(),
    host: location.host,
    protocol: location.protocol === "https:" ? "wss" : "ws",
    onStateUpdate: (update) => {
      state = update;
      if (update.revision !== seenRevision) {
        seenRevision = update.revision;
        void refresh().catch(reportFailure);
      } else render();
    },
  });
  client = next;
  next.addEventListener("open", () => {
    setConnection("Ready for questions", "open", true);
    void refresh().catch(reportFailure);
  });
  next.addEventListener("close", () => setConnection("Reconnecting", "connecting", false));
  next.addEventListener("message", (event) => {
    // The socket also carries SDK frames, so a cheap test avoids parsing most of them.
    if (typeof event.data !== "string" || !/"answer-(?:delta|reset)"/.test(event.data)) return;
    try {
      const message = JSON.parse(event.data) as LiveMessage;
      if (message.type === "answer-delta" || message.type === "answer-reset") handleLiveMessage(message);
    } catch {
      // Ignore frames that are not application messages.
    }
  });
}

/**
 * Reads the profile data built into the page and attaches its controls. Rendering matches the built
 * HTML, so nothing moves. The ask experience still works if the data is missing.
 */
function loadProfile(): void {
  try {
    site = JSON.parse(byId("site-data").textContent ?? "") as SiteContent;
    renderProfile(site, (question) => void ask(question));
  } catch {
    site = null;
    setText("name", "Ask about this work");
    byId("load-error").hidden = false;
  }
}

/** Applies a theme and labels the toggle with the theme it will switch to. */
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  ui.theme.textContent = theme === "dark" ? "Light" : "Dark";
  ui.theme.setAttribute("aria-pressed", String(theme === "dark"));
}

const savedTheme = readStored(THEME_KEY);
const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
applyTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : prefersDark ? "dark" : "light");
ui.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  writeStored(THEME_KEY, next);
});
ui.input.addEventListener("input", updateComposer);
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void ask(ui.input.value);
  }
});
ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask(ui.input.value);
});
ui.mic.addEventListener("click", () => void toggleRecording());

loadProfile();
render();
connect();
