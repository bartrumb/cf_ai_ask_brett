/*
 * Embeddable chat for another page on a host that forwards `/agents/*` to this Worker, such as
 * brett.bartrum.family. It mounts into each element with `data-ask-widget`, connects to the same
 * ShowcaseAgent over the page's own host and reuses the standalone app's voice and rich-text code.
 * The host page owns the styles. All dynamic text is added as text nodes.
 */
import { AgentClient } from "agents/client";
import type { ActionResult, AnswerSource, ChatMessage, LiveMessage, ShowcaseState, Snapshot, SpokenPart } from "../src/domain/types";
import { h } from "./profile";
import { renderRichText } from "./rich-text";
import { startRecording, startSpeech, stopPlayback, type Recording } from "./voice";

/** Mirrors the server limit so the composer can warn before submitting. */
export const MAX_QUESTION_CHARS = 500;
/** Suggested questions shown at most. */
const MAX_SUGGESTIONS = 8;
/** localStorage key for this browser's conversation on the host page. */
export const CONVERSATION_KEY = "ask-brett-conversation";
/** Backstop for a whole streamed answer. Parts play as they arrive, well before this. */
const SPEECH_CALL_TIMEOUT_MS = 60_000;
/** Labels shown under answers. */
const SOURCE_LABELS: Record<AnswerSource, string> = {
  "workers-ai": "AI-generated",
  offline: "Offline preview",
  guarded: "Standard reply",
  unavailable: "Not answered",
};

/** Options for one mounted widget. */
export interface WidgetOptions {
  /** Suggested questions, shown as buttons. */
  questions: readonly string[];
  /** Text shown before the first question. */
  emptyText?: string;
}

/** Reads storage, which can throw under strict privacy settings. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes storage. The widget works for this visit if it cannot. */
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

/** Reads suggested questions from a `data-questions` JSON array, ignoring anything malformed. */
export function parseQuestions(raw: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_QUESTION_CHARS).slice(0, MAX_SUGGESTIONS);
  } catch {
    return [];
  }
}

let mountCount = 0;

/**
 * Builds the chat inside `root` and connects it.
 *
 * @returns A handle that closes the connection and stops any audio.
 */
export function mountAskWidget(root: HTMLElement, options: WidgetOptions): { destroy: () => void } {
  mountCount += 1;
  const inputId = `ask-widget-question-${mountCount}`;
  const status = h("p", { class: "ask-status", role: "status", "data-state": "connecting" }, "Connecting");
  const suggestions = h("ul", { class: "ask-suggestions", "aria-label": "Suggested questions" });
  const log = h("div", { class: "ask-log", role: "log", "aria-label": "Conversation", tabindex: "0" });
  const notice = h("p", { class: "ask-notice", role: "alert", hidden: true });
  const input = h("textarea", { id: inputId, rows: "3", maxlength: String(MAX_QUESTION_CHARS), placeholder: "Ask about his work, results or the roles he wants", autocomplete: "off" });
  const count = h("span", { class: "ask-count" }, `0 / ${MAX_QUESTION_CHARS}`);
  const mic = h("button", { class: "ask-mic", type: "button", "aria-pressed": "false" }, "Speak");
  const send = h("button", { class: "ask-send", type: "submit", disabled: true }, "Ask");
  const form = h("form", { class: "ask-composer" }, h("label", { for: inputId }, "Your question"), input, h("div", { class: "ask-row" }, count, mic, send));
  root.classList.add("ask-widget");
  root.replaceChildren(status, suggestions, log, notice, form);

  let client: AgentClient<unknown, ShowcaseState> | null = null;
  let connected = false;
  let snapshot: Snapshot | null = null;
  let state: ShowcaseState | null = null;
  let seenRevision = -1;
  let liveAnswer = "";
  let pendingBody: HTMLElement | null = null;
  let submitting = false;
  let refreshing = false;
  let refreshQueued = false;
  let recording: Recording | null = null;
  let transcribing = false;
  let speakingId: number | null = null;
  let speechLoading = false;
  /** A send whose outcome is unknown. Retrying the same text reuses its ID, so it is not charged twice. */
  let unconfirmed: { question: string; requestId: string } | null = null;

  const setNotice = (message: string) => {
    notice.textContent = message;
    notice.hidden = !message;
  };
  const reportFailure = () => setNotice("Something went wrong. Please try again.");
  const isBusy = () => Boolean(state?.activeQuestion) || submitting;

  const updateComposer = () => {
    const length = input.value.length;
    count.textContent = `${length} / ${MAX_QUESTION_CHARS}`;
    count.classList.toggle("over", length >= MAX_QUESTION_CHARS);
    send.disabled = !connected || isBusy() || !input.value.trim() || length > MAX_QUESTION_CHARS;
    send.textContent = isBusy() ? "Answering" : "Ask";
    mic.disabled = !connected || transcribing;
    mic.textContent = recording ? "Stop" : transcribing ? "Transcribing" : "Speak";
    mic.setAttribute("aria-pressed", String(Boolean(recording)));
    for (const button of suggestions.querySelectorAll("button")) button.disabled = !connected || isBusy();
  };

  const listenButton = (id: number) =>
    h("button", { class: "ask-listen", type: "button", onClick: () => void toggleSpeech(id) }, speakingId === id ? (speechLoading ? "Preparing audio" : "Stop") : "Listen");

  const messageNode = (message: ChatMessage): HTMLElement => {
    if (message.role === "user") return h("div", { class: "ask-message ask-user" }, message.text);
    const body = h("div", { class: "ask-body" });
    renderRichText(body, message.text);
    return h(
      "article",
      { class: "ask-message ask-answer" },
      body,
      h("div", { class: "ask-foot" }, message.source && SOURCE_LABELS[message.source], message.source !== "unavailable" && listenButton(message.id)),
    );
  };

  const pendingNode = (): HTMLElement => {
    pendingBody = h("div", { class: "ask-body" });
    if (liveAnswer) renderRichText(pendingBody, liveAnswer);
    else pendingBody.append(h("p", { class: "ask-thinking" }, "Thinking"));
    return h("article", { class: "ask-message ask-answer", "aria-busy": "true" }, pendingBody);
  };

  /** Rebuilds the conversation, following the end when the reader is already there. */
  const render = () => {
    const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    pendingBody = null;
    const nodes: Node[] = (snapshot?.messages ?? []).map(messageNode);
    if (state?.activeQuestion || submitting) nodes.push(pendingNode());
    if (nodes.length === 0) nodes.push(h("p", { class: "ask-empty" }, options.emptyText ?? "Pick a question, or ask your own."));
    log.replaceChildren(...nodes);
    if (follow) log.scrollTop = log.scrollHeight;
    updateComposer();
  };

  /** Fetches stored messages. Calls during a fetch collapse into one follow-up. */
  const refresh = async (): Promise<void> => {
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
  };

  /** Sends a question. Its answer arrives through live messages and a later snapshot. */
  const ask = async (question: string): Promise<void> => {
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
      if (result.ok) input.value = "";
      else setNotice(result.error);
    } catch {
      setNotice("The connection dropped. Your question was kept, so you can send it again.");
      input.value = text;
    } finally {
      submitting = false;
      render();
      void refresh().catch(reportFailure);
    }
  };

  /** Starts recording, or stops it. The transcript goes to the composer for checking. */
  const toggleRecording = async (): Promise<void> => {
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
        input.value = [input.value.trim(), result.text].filter(Boolean).join(" ").slice(0, MAX_QUESTION_CHARS);
        input.focus();
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
  };

  /** Plays an answer, or stops it when already selected. Late responses cannot override a newer choice. */
  const toggleSpeech = async (id: number): Promise<void> => {
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
  };

  /** Applies streamed text directly, avoiding a full render per delta. */
  const handleLiveMessage = (message: LiveMessage) => {
    liveAnswer = message.type === "answer-reset" ? "" : liveAnswer + message.delta;
    if (pendingBody && liveAnswer) renderRichText(pendingBody, liveAnswer);
    log.scrollTop = log.scrollHeight;
  };

  const setConnection = (label: string, stateName: string, open: boolean) => {
    status.textContent = label;
    status.dataset.state = stateName;
    connected = open;
    updateComposer();
  };

  suggestions.replaceChildren(
    ...options.questions.map((question) => h("li", {}, h("button", { type: "button", disabled: true, onClick: () => void ask(question) }, question))),
  );
  input.addEventListener("input", updateComposer);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void ask(input.value);
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void ask(input.value);
  });
  mic.addEventListener("click", () => void toggleRecording());

  client = new AgentClient<unknown, ShowcaseState>({
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
  const owner = client;
  owner.addEventListener("open", () => {
    setConnection("Ready for questions", "open", true);
    void refresh().catch(reportFailure);
  });
  owner.addEventListener("close", () => setConnection("Reconnecting", "connecting", false));
  owner.addEventListener("message", (event) => {
    // The socket also carries SDK frames, so a cheap test avoids parsing most of them.
    const data = (event as MessageEvent).data;
    if (typeof data !== "string" || !/"answer-(?:delta|reset)"/.test(data)) return;
    try {
      const message = JSON.parse(data) as LiveMessage;
      if (message.type === "answer-delta" || message.type === "answer-reset") handleLiveMessage(message);
    } catch {
      // Ignore frames that are not application messages.
    }
  });
  render();

  return {
    destroy() {
      stopPlayback();
      recording?.stop();
      owner.close();
      client = null;
      connected = false;
    },
  };
}

/** Mounts every `[data-ask-widget]` element in the document once. */
export function mountAll(doc: Document = document): number {
  let mounted = 0;
  for (const element of doc.querySelectorAll<HTMLElement>("[data-ask-widget]")) {
    if (element.dataset.askMounted) continue;
    element.dataset.askMounted = "true";
    mountAskWidget(element, { questions: parseQuestions(element.dataset.questions), emptyText: element.dataset.emptyText });
    mounted += 1;
  }
  return mounted;
}

if (typeof document !== "undefined") mountAll();
