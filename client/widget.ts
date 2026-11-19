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
import { dictationSupported, startDictation, startRecording, startSpeech, stopPlayback, type Dictation, type Recording } from "./voice";

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
  /** Where the host serves `capture-processor.js` for live dictation. */
  workletUrl?: string;
}

/** Default worklet location on a host page. */
const DEFAULT_WORKLET_URL = "/js/capture-processor.js";

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
  let dictation: Dictation | null = null;
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
    const listening = Boolean(recording || dictation);
    mic.disabled = !connected || transcribing;
    mic.textContent = listening ? "Stop" : transcribing ? "Transcribing" : "Speak";
    mic.setAttribute("aria-pressed", String(listening));
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

  /** Shows a microphone failure in plain words. */
  const reportMicError = (error: unknown) => {
    const name = error instanceof DOMException ? error.name : "";
    setNotice(
      name === "NotAllowedError" ? "Microphone access was blocked. You can allow it in the browser's site settings."
      : name === "NotFoundError" ? "No microphone was found."
      : name === "NotReadableError" ? "The microphone is in use by another app."
      : "The recording could not be processed.",
    );
  };

  /**
   * Live dictation: words appear in the composer while the visitor speaks. Starts synchronously
   * inside the click, which iOS requires for audio. Returns false when it cannot run, so the
   * caller can record instead.
   */
  const dictate = async (): Promise<boolean> => {
    const prefix = input.value.trim();
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/agents/dictation`;
    const live = startDictation(url, options.workletUrl ?? DEFAULT_WORKLET_URL, (text) => {
      input.value = [prefix, text].filter(Boolean).join(" ").slice(0, MAX_QUESTION_CHARS);
      updateComposer();
    });
    dictation = live;
    updateComposer();
    try {
      await live.ready;
    } catch (error) {
      dictation = null;
      updateComposer();
      if (error instanceof DOMException && error.name !== "AbortError") {
        reportMicError(error);
        return true;
      }
      return false;
    }
    try {
      await live.result;
    } finally {
      dictation = null;
      updateComposer();
      input.focus();
    }
    return true;
  };

  /** Starts listening, or stops it. The transcript goes to the composer for checking. */
  const toggleRecording = async (): Promise<void> => {
    if (dictation) {
      dictation.stop();
      return;
    }
    if (recording) {
      recording.stop();
      return;
    }
    setNotice("");
    if (dictationSupported() && (await dictate())) return;
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

/** sessionStorage key that reopens the launcher's panel after a reload in the same tab. */
export const LAUNCHER_OPEN_KEY = "ask-brett-open";

/** Reads session storage, which can throw under strict privacy settings. */
function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes session storage. The panel simply does not reopen if it cannot. */
function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Nothing to do.
  }
}

/**
 * Builds a floating button with an avatar that opens the chat in a panel. The chat connects on
 * first hover, focus or touch of the button, so a page view alone opens no socket. Links to
 * `#ask` and elements with `data-ask-open` open the panel too.
 *
 * Reads `data-avatar`, `data-label`, `data-title`, `data-intro`, `data-questions`,
 * `data-empty-text` and `data-worklet` from `root`.
 *
 * @returns A handle to open and close the panel, for the host page and tests.
 */
export function mountLauncher(root: HTMLElement, doc: Document = document): { open: (focus?: boolean) => void; close: () => void } {
  mountCount += 1;
  const panelId = `ask-panel-${mountCount}`;
  const titleId = `ask-panel-title-${mountCount}`;
  const { avatar = "", label = "Ask about my work", title = label, intro = "" } = root.dataset;
  const avatarImage = (size: number) => h("img", { src: avatar, alt: "", width: String(size), height: String(size), decoding: "async" });

  const fab = h("button", { class: "ask-fab", type: "button", "aria-expanded": "false", "aria-controls": panelId, "aria-label": label },
    avatar && avatarImage(64), h("span", { class: "ask-fab-text", "aria-hidden": "true" }, label));
  const close = h("button", { class: "ask-close", type: "button", "aria-label": "Close chat" }, "×");
  const heading = h("h2", { id: titleId, tabindex: "-1" }, title);
  const body = h("div", { class: "ask-panel-body" });
  const panel = h("div", { class: "ask-panel", id: panelId, role: "dialog", "aria-modal": "false", "aria-labelledby": titleId, hidden: true },
    h("div", { class: "ask-panel-head" }, avatar && avatarImage(40), h("div", { class: "ask-panel-titles" }, heading, intro && h("p", {}, intro)), close),
    body);
  root.classList.add("ask-launcher");
  root.replaceChildren(panel, fab);

  let widget: { destroy: () => void } | null = null;
  const warm = () => {
    widget ??= mountAskWidget(body, { questions: parseQuestions(root.dataset.questions), emptyText: root.dataset.emptyText, workletUrl: root.dataset.worklet });
  };

  // iOS Safari keeps 100dvh at full height while the keyboard is up, which hides the composer.
  // While open on a small screen, size the panel to the visual viewport instead.
  const view = window.visualViewport;
  const fitViewport = () => {
    if (!view) return;
    root.style.setProperty("--ask-vvh", `${Math.round(view.height)}px`);
    root.style.setProperty("--ask-vvtop", `${Math.round(view.offsetTop)}px`);
  };
  const small = () => window.matchMedia("(max-width: 640px)").matches;

  const openPanel = (focus = true) => {
    warm();
    if (!panel.hidden) return;
    panel.hidden = false;
    root.dataset.open = "true";
    fab.setAttribute("aria-expanded", "true");
    writeSession(LAUNCHER_OPEN_KEY, "1");
    fitViewport();
    view?.addEventListener("resize", fitViewport);
    view?.addEventListener("scroll", fitViewport);
    if (small()) doc.documentElement.classList.add("ask-locked");
    if (!focus) return;
    // A fine pointer means a keyboard is likely, so go straight to the question box. On touch,
    // focusing the box would throw up the keyboard over the suggestions, so focus the title.
    const box = body.querySelector("textarea");
    if (box && window.matchMedia("(pointer: fine)").matches) box.focus();
    else heading.focus();
  };
  const closePanel = () => {
    if (panel.hidden) return;
    panel.hidden = true;
    delete root.dataset.open;
    fab.setAttribute("aria-expanded", "false");
    writeSession(LAUNCHER_OPEN_KEY, null);
    view?.removeEventListener("resize", fitViewport);
    view?.removeEventListener("scroll", fitViewport);
    doc.documentElement.classList.remove("ask-locked");
    stopPlayback();
    fab.focus();
  };

  fab.addEventListener("click", () => (panel.hidden ? openPanel() : closePanel()));
  for (const type of ["pointerenter", "focus", "touchstart"]) fab.addEventListener(type, warm, { once: true, passive: true });
  close.addEventListener("click", closePanel);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  });
  doc.addEventListener("click", (event) => {
    const trigger = (event.target as Element | null)?.closest?.('a[href="#ask"], [data-ask-open]');
    if (!trigger) return;
    event.preventDefault();
    openPanel();
  });
  if (readSession(LAUNCHER_OPEN_KEY) === "1") openPanel(false);
  return { open: openPanel, close: closePanel };
}

/** Mounts every `[data-ask-widget]` and `[data-ask-launcher]` element in the document once. */
export function mountAll(doc: Document = document): number {
  let mounted = 0;
  for (const element of doc.querySelectorAll<HTMLElement>("[data-ask-widget]")) {
    if (element.dataset.askMounted) continue;
    element.dataset.askMounted = "true";
    mountAskWidget(element, { questions: parseQuestions(element.dataset.questions), emptyText: element.dataset.emptyText, workletUrl: element.dataset.worklet });
    mounted += 1;
  }
  for (const element of doc.querySelectorAll<HTMLElement>("[data-ask-launcher]")) {
    if (element.dataset.askMounted) continue;
    element.dataset.askMounted = "true";
    mountLauncher(element, doc);
    mounted += 1;
  }
  return mounted;
}

if (typeof document !== "undefined") mountAll();
