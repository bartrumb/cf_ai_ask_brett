/*
 * Browser application: connects to one repository's agent, renders its snapshot and sends user
 * actions. The server validates everything, so limits checked here only improve feedback.
 *
 * Rendering is a full rebuild from `snapshot` and `guardState`. Streaming text is the exception: it
 * is patched into the existing DOM. Voice capture and playback live in `voice.ts`.
 */
import { AgentClient } from "agents/client";
import type {
  ActionResult,
  ChatMessage,
  CommentarySource,
  Finding,
  GuardState,
  LiveMessage,
  ReviewRecord,
  Snapshot,
  StepName,
  StepStatus,
} from "../src/domain/types";
import { SAMPLES } from "./samples";
import { playAudio, startRecording, stopPlayback, type Recording } from "./voice";

/** Mirrors the server limit so the composer can warn before submitting. */
const MAX_INPUT_CHARS = 40_000;
/** Repository opened when the URL and saved preference name none. */
const DEFAULT_REPO = "sample-payments-api";
/** Display order and text for review progress. */
const STEP_LABELS: Record<StepName, string> = {
  intake: "Input accepted",
  rules: "Rules evaluated",
  commentary: "AI commentary",
  save: "Saved to memory",
};

/** Values accepted as children by `h`. Falsy values render nothing. */
type Child = Node | string | null | undefined | false;
/** Attributes for `h`. Function values whose keys start with `on` become event listeners. */
type Props = Record<string, string | boolean | EventListener | undefined>;

/**
 * Creates an element. `true` sets an empty attribute; `false` and `undefined` omit it.
 *
 * @param tag - Element name.
 * @param props - Attributes and `onEvent` listeners.
 * @param children - Nodes or strings. Strings become text nodes.
 */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, value);
  }
  // Text is always added as text nodes. Submitted content never becomes HTML.
  for (const child of children) if (child) element.append(child);
  return element;
}

/**
 * Finds a required element.
 *
 * @throws Error when the element is missing.
 */
function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

/** Static page elements. Resolving them at load makes a page mismatch fail immediately. */
const ui = {
  timeline: byId<HTMLElement>("timeline"),
  scroller: byId<HTMLElement>("chat-scroll"),
  input: byId<HTMLTextAreaElement>("change-input"),
  count: byId<HTMLElement>("char-count"),
  samples: byId<HTMLElement>("samples"),
  review: byId<HTMLButtonElement>("review-button"),
  ask: byId<HTMLButtonElement>("ask-button"),
  mic: byId<HTMLButtonElement>("mic-button"),
  routing: byId<HTMLElement>("routing"),
  notice: byId<HTMLElement>("notice"),
  status: byId<HTMLElement>("connection"),
  repoForm: byId<HTMLFormElement>("repo-form"),
  repoInput: byId<HTMLInputElement>("repo-input"),
  standards: byId<HTMLElement>("standards"),
  standardCount: byId<HTMLElement>("standard-count"),
  exceptions: byId<HTMLElement>("exceptions"),
  exceptionCount: byId<HTMLElement>("exception-count"),
  history: byId<HTMLElement>("history"),
  historyCount: byId<HTMLElement>("history-count"),
  dialog: byId<HTMLDialogElement>("exception-dialog"),
  dialogForm: byId<HTMLFormElement>("exception-form"),
  dialogTarget: byId<HTMLElement>("exception-target"),
  dialogReason: byId<HTMLTextAreaElement>("exception-reason"),
  dialogError: byId<HTMLElement>("exception-error"),
  dialogCancel: byId<HTMLButtonElement>("exception-cancel"),
};

/**
 * Current connection. Async work compares against this to discard results for an old repository.
 */
let client: AgentClient<unknown, GuardState> | null = null;
/** Latest stored data from `getSnapshot`. */
let snapshot: Snapshot | null = null;
/** Latest synced progress state. */
let guardState: GuardState | null = null;
/** Revision of the last state that triggered a refetch. */
let seenRevision = -1;
/** Streamed text of the question being answered. */
let liveAnswer = "";
/** True between sending a question and the server accepting it. */
let submittingQuestion = false;
/** Finding the exception dialog is editing. */
let exceptionTarget: { reviewId: string; finding: Finding } | null = null;
/** Active microphone capture. */
let recording: Recording | null = null;
/** True while a recording is being transcribed. */
let transcribing = false;
/** `kind:id` of the item being fetched or played as speech. */
let speakingKey: string | null = null;
/** Streamed commentary by review ID, kept until the stored version arrives. */
const liveCommentary = new Map<string, string>();

/** Successful response from `speak`. */
interface SpeechResult {
  audio: string;
  mimeType: string;
  source: CommentarySource;
}

/** Successful response from `transcribe`. */
interface TranscriptResult {
  text: string;
  source: CommentarySource;
}

/** Converts free text to a name accepted by `repositoryNameSchema`, or an empty string. */
function toSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
}

/**
 * Chooses the first repository. Storage access can throw, for example under strict privacy settings.
 */
function initialRepository(): string {
  const fromUrl = toSlug(new URLSearchParams(location.search).get("repo") ?? "");
  if (fromUrl) return fromUrl;
  try {
    return toSlug(localStorage.getItem("codex-guard-repo") ?? "") || DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}

/** Shows a message in the notice area. An empty message hides it. */
function setNotice(message: string): void {
  ui.notice.textContent = message;
  ui.notice.hidden = !message;
}

/** True when the reader is following the end of the timeline. */
function isNearBottom(): boolean {
  const { scrollHeight, scrollTop, clientHeight } = ui.scroller;
  return scrollHeight - scrollTop - clientHeight < 120;
}

/** Scrolls the timeline to its newest content. */
function scrollToEnd(): void {
  ui.scroller.scrollTop = ui.scroller.scrollHeight;
}

/** True while a review or question prevents another submission. */
function isBusy(): boolean {
  return Boolean(guardState?.active || guardState?.activeQuestion) || submittingQuestion;
}

/** Synchronizes the character count, submit buttons and microphone control with current state. */
function updateComposer(): void {
  const length = ui.input.value.length;
  const hasText = ui.input.value.trim().length > 0;
  ui.count.textContent = `${length.toLocaleString("en-US")} / ${MAX_INPUT_CHARS.toLocaleString("en-US")}`;
  ui.count.classList.toggle("over", length > MAX_INPUT_CHARS);
  const blocked = !client || isBusy() || !hasText || length > MAX_INPUT_CHARS;
  ui.review.disabled = blocked;
  // Mirrors `MAX_QUESTION_CHARS`.
  ui.ask.disabled = blocked || length > 2_000;
  ui.mic.disabled = !client || transcribing;
  ui.mic.textContent = recording ? "Stop recording" : transcribing ? "Transcribing…" : "Speak";
  ui.mic.classList.toggle("recording", Boolean(recording));
  ui.mic.setAttribute("aria-pressed", String(Boolean(recording)));
}

/** Describes where AI text came from. */
function sourceLabel(source: CommentarySource | null, model: string | null): string {
  if (source === "offline") return "Offline template, no model called";
  if (source === "unavailable") return "Unavailable";
  const gateway = snapshot?.routing.gatewayId;
  return `${model ?? "Workers AI"}${gateway ? ` via AI Gateway ${gateway}` : ""}`;
}

/** Builds the control that starts or stops speech for a review or message. */
function listenButton(kind: "review" | "message", id: string | number): HTMLElement {
  const key = `${kind}:${id}`;
  return h(
    "button",
    { class: "link-button listen", type: "button", onClick: () => void toggleSpeech(kind, id) },
    speakingKey === key ? "Stop" : "Listen",
  );
}

/**
 * Renders the commentary format as text nodes, with headings for readability.
 * This is not a Markdown parser: model output never becomes HTML.
 */
function renderCommentary(target: HTMLElement, text: string): void {
  target.replaceChildren();
  let code: HTMLElement | null = null;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      code = code ? null : target.appendChild(h("pre"));
      continue;
    }
    if (code) code.append(`${line}\n`);
    else if (line.startsWith("### ")) target.append(h("h4", {}, line.slice(4)));
    else if (line.trim()) {
      const label = /^\**(Why it matters|Suggested fix):\**\s*(.*)$/.exec(line);
      if (label) target.append(h("p", {}, h("strong", {}, `${label[1]}: `), label[2] ?? ""));
      else target.append(h("p", {}, line));
    }
  }
}

/** Renders review progress. */
function stepper(steps: Record<StepName, StepStatus>): HTMLElement {
  const names = Object.keys(STEP_LABELS) as StepName[];
  return h(
    "ol",
    { class: "steps", "aria-label": "Review progress" },
    ...names.map((name) => h("li", { class: `step ${steps[name]}` }, h("span", { class: "dot" }), STEP_LABELS[name])),
  );
}

/** True when an exception now covers this finding, even if this older result predates it. */
function hasExceptionOnFile(finding: Finding): boolean {
  return Boolean(snapshot?.exceptions.some((e) => e.standardId === finding.standardId && e.path === finding.path));
}

/** Renders one finding with the action its waiver state allows. */
function findingRow(review: ReviewRecord, finding: Finding): HTMLElement {
  const location = finding.line ? `${finding.path}:${finding.line}` : finding.path;
  let action: Child;
  if (finding.status === "excepted") {
    const reason = snapshot?.exceptions.find((e) => e.id === finding.exceptionId)?.reason;
    action = h("span", { class: "finding-state" }, reason ? `Exception applied: ${reason}` : "Exception applied");
  } else if (!finding.waivable) {
    action = h("span", { class: "finding-state" }, "Cannot be waived");
  } else if (hasExceptionOnFile(finding)) {
    action = h("span", { class: "finding-state" }, "Exception recorded. It applies from the next review.");
  } else {
    action = h("button", { class: "link-button", type: "button", onClick: () => openExceptionDialog(review.id, finding) }, "Accept as exception");
  }
  return h(
    "li",
    { class: `finding ${finding.status}` },
    h("span", { class: `severity ${finding.severity}` }, finding.severity),
    h(
      "div",
      { class: "finding-body" },
      h("p", { class: "finding-title" }, h("code", {}, finding.standardId), ` ${finding.standardTitle}`),
      h("p", { class: "finding-location" }, `${finding.id} · ${location}`, finding.occurrences > 1 && ` · ${finding.occurrences} matches`),
      finding.evidence && h("code", { class: "evidence" }, finding.evidence),
      h("div", { class: "finding-action" }, action),
    ),
  );
}

/** Renders rule results, or a progress or failure message before results exist. */
function rulePanel(review: ReviewRecord): HTMLElement {
  const result = review.result;
  if (!result) {
    return h(
      "section",
      { class: "panel rules" },
      h("header", {}, h("span", { class: "panel-label" }, "Rule engine"), h("span", { class: "panel-tag" }, "Deterministic")),
      h("p", { class: "muted" }, review.status === "failed" ? (review.error ?? "The review failed.") : "Evaluating rules…"),
    );
  }
  const lowered = result.risk !== result.riskBeforeExceptions;
  const stats = result.kind === "diff" ? `${result.stats.files} file${result.stats.files === 1 ? "" : "s"}, +${result.stats.additions} −${result.stats.deletions}` : "Change summary";
  return h(
    "section",
    { class: "panel rules" },
    h("header", {}, h("span", { class: "panel-label" }, "Rule engine"), h("span", { class: "panel-tag" }, "Deterministic · final")),
    h(
      "div",
      { class: "risk-row" },
      h("span", { class: `risk ${result.risk}` }, `${result.risk} risk`),
      h("span", { class: "muted" }, stats, lowered && ` · ${result.riskBeforeExceptions} before exceptions`),
    ),
    ...result.notes.map((note) => h("p", { class: "note" }, note)),
    result.findings.length
      ? h("ul", { class: "findings" }, ...result.findings.map((finding) => findingRow(review, finding)))
      : h("p", { class: "muted" }, "No rule matched this change."),
    h("p", { class: "checked" }, `Checked against: ${result.applicableStandards.join(", ") || "no applicable standards"}`),
  );
}

/**
 * Renders commentary, preferring stored text over streamed text. Returns null before rules finish.
 */
function aiPanel(review: ReviewRecord): HTMLElement | null {
  if (!review.result) return null;
  const text = review.commentary || liveCommentary.get(review.id) || "";
  const body = h("div", { class: "commentary", "data-commentary": review.id });
  if (text) renderCommentary(body, text);
  else if (review.commentarySource === "unavailable") body.append(h("p", { class: "muted" }, "The model was unavailable. The rule results above are complete."));
  else if (review.status === "running") body.append(h("p", { class: "muted cursor" }, "Writing an explanation"));
  return h(
    "section",
    { class: "panel ai" },
    h("header", {}, h("span", { class: "panel-label" }, "AI commentary"), h("span", { class: "panel-tag" }, "Advisory · cannot change the result")),
    body,
    ...review.commentaryWarnings.map((warning) => h("p", { class: "warning" }, `Check: ${warning}`)),
    h(
      "div",
      { class: "panel-foot" },
      h("p", { class: "checked" }, sourceLabel(review.commentarySource, review.commentaryModel)),
      review.status === "complete" && listenButton("review", review.id),
    ),
  );
}

/** Renders a review, with live progress when it is the active one. */
function reviewCard(review: ReviewRecord): HTMLElement {
  const active = guardState?.active?.reviewId === review.id ? guardState.active : null;
  return h(
    "article",
    { class: "review", id: `review-${review.id}` },
    h("h3", {}, review.title || "Change review"),
    active && stepper(active.steps),
    rulePanel(review),
    aiPanel(review),
  );
}

/** Renders one chat entry. A review entry also renders its review card. */
function messageNode(message: ChatMessage, reviews: Map<string, ReviewRecord>): Child[] {
  if (message.kind === "review") {
    const review = message.reviewId ? reviews.get(message.reviewId) : undefined;
    return [h("div", { class: "bubble user" }, h("pre", {}, message.text)), review && reviewCard(review)];
  }
  if (message.role === "user") return [h("div", { class: "bubble user" }, message.text)];
  const body = h("div", { class: "commentary" });
  renderCommentary(body, message.text);
  return [
    h(
      "div",
      { class: "bubble assistant" },
      h("span", { class: "bubble-label" }, `AI answer · ${sourceLabel(message.source, message.model)}`),
      body,
      listenButton("message", message.id),
    ),
  ];
}

/** Renders the introduction for a repository with no messages. */
function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    h("h2", {}, "Check a change before you open the pull request"),
    h("p", {}, "Paste a unified diff or describe the change. Fixed rules set the risk and pick the standards. The model explains the findings and suggests fixes, and it cannot change the result."),
    h("p", { class: "muted" }, "Pick a sample below to see it work."),
  );
}

/** Rebuilds the timeline and sidebar, keeping the reader at the end if they were already there. */
function render(): void {
  if (!snapshot) return;
  const follow = isNearBottom();
  const reviews = new Map(snapshot.reviews.map((review) => [review.id, review]));
  const nodes = snapshot.messages.flatMap((message) => messageNode(message, reviews)).filter((node): node is Node | string => Boolean(node));
  if (guardState?.activeQuestion) {
    const body = h("div", { class: "commentary" });
    renderCommentary(body, liveAnswer || "Thinking…");
    nodes.push(h("div", { class: "bubble assistant", id: "pending-answer" }, h("span", { class: "bubble-label" }, "AI answer"), body));
  }
  ui.timeline.replaceChildren(...(nodes.length ? nodes : [emptyState()]));
  renderSidebar();
  updateComposer();
  if (follow) scrollToEnd();
}

/** Rebuilds routing, standards, exceptions and review history. */
function renderSidebar(): void {
  if (!snapshot) return;
  const { routing } = snapshot;
  ui.routing.replaceChildren(
    h("li", { class: "muted" }, routing.offline ? "Offline mode: no model or gateway is called." : `All calls use AI Gateway: ${routing.gatewayId}`),
    ...routing.models.map((model) =>
      h(
        "li",
        { class: "route" },
        h("strong", {}, model.label),
        h("code", {}, model.primary.replace("@cf/", "")),
        h("code", { class: "muted" }, `fallback ${model.secondary.replace("@cf/", "")}`),
      ),
    ),
  );
  const enabled = snapshot.standards.filter((standard) => standard.enabled).length;
  ui.standardCount.textContent = `${enabled}/${snapshot.standards.length}`;
  ui.standards.replaceChildren(
    ...snapshot.standards.map((standard) =>
      h(
        "li",
        { class: "standard" },
        h(
          "label",
          { title: standard.summary },
          h("input", {
            type: "checkbox",
            checked: standard.enabled,
            disabled: !standard.waivable,
            onChange: (event: Event) => toggleStandard(standard.id, (event.target as HTMLInputElement).checked),
          }),
          h("span", {}, h("code", {}, standard.id), h("span", { class: "standard-title" }, standard.title)),
          h("span", { class: `severity small ${standard.severity}` }, standard.waivable ? standard.severity : "required"),
        ),
      ),
    ),
  );

  ui.exceptionCount.textContent = String(snapshot.exceptions.length);
  ui.exceptions.replaceChildren(
    ...(snapshot.exceptions.length
      ? snapshot.exceptions.map((exception) =>
          h(
            "li",
            { class: "exception" },
            h("p", {}, h("code", {}, exception.standardId), ` ${exception.path}`),
            h("p", { class: "muted" }, exception.reason),
            h("button", { class: "link-button", type: "button", onClick: () => revokeException(exception.id) }, "Revoke"),
          ),
        )
      : [h("li", { class: "muted" }, "None recorded.")]),
  );

  ui.historyCount.textContent = String(snapshot.reviews.length);
  ui.history.replaceChildren(
    ...(snapshot.reviews.length
      ? snapshot.reviews.slice(0, 12).map((review) =>
          h(
            "li",
            {},
            h(
              "button",
              { class: "history-item", type: "button", onClick: () => byId(`review-${review.id}`).scrollIntoView({ behavior: "smooth", block: "start" }) },
              h("span", { class: `severity small ${review.result?.risk ?? "pending"}` }, review.result?.risk ?? review.status),
              h("span", { class: "history-title" }, review.title),
            ),
          ),
        )
      : [h("li", { class: "muted" }, "No reviews yet.")]),
  );
}

/**
 * Fetches and renders the snapshot. A response for a replaced connection is dropped.
 *
 * @throws The RPC error, which callers report.
 */
async function refresh(): Promise<void> {
  if (!client) return;
  const current = client;
  const next = (await current.call("getSnapshot")) as unknown as Snapshot;
  if (current !== client) return;
  snapshot = next;
  for (const review of next.reviews) if (review.status !== "running") liveCommentary.delete(review.id);
  render();
}

/** Shows an unexpected failure in the notice area. */
function reportFailure(error: unknown): void {
  setNotice(error instanceof Error ? error.message : "Something went wrong.");
}

/** Starts a review. The input is cleared only after the server accepts it. */
async function submitReview(): Promise<void> {
  if (!client || ui.review.disabled) return;
  setNotice("");
  ui.review.disabled = true;
  try {
    const request = { text: ui.input.value, requestId: crypto.randomUUID() };
    const result = (await client.call("startReview", [request])) as ActionResult;
    if (!result.ok) setNotice(result.error);
    else ui.input.value = "";
  } catch (error) {
    reportFailure(error);
  }
  updateComposer();
}

/**
 * Sends the composer text as a question. Questions enter the agent's durable inbox, so they finish
 * if this tab closes. The answer arrives through live messages and a later snapshot.
 */
async function submitQuestion(): Promise<void> {
  if (!client || ui.ask.disabled) return;
  setNotice("");
  submittingQuestion = true;
  liveAnswer = "";
  updateComposer();
  try {
    const request = { question: ui.input.value.trim(), requestId: crypto.randomUUID() };
    const result = (await client.call("ask", [request])) as ActionResult;
    if (!result.ok) setNotice(result.error);
    else ui.input.value = "";
  } catch (error) {
    reportFailure(error);
  } finally {
    submittingQuestion = false;
    updateComposer();
  }
}

/**
 * Starts recording, or stops the active recording. The starting call stays pending until
 * transcription ends, then appends the transcript to the composer for review. It uses whichever
 * connection is current when the recording finishes.
 */
async function toggleRecording(): Promise<void> {
  if (recording) {
    recording.stop();
    return;
  }
  setNotice("");
  try {
    const active = await startRecording();
    recording = active;
    updateComposer();
    const audio = await active.result;
    recording = null;
    transcribing = true;
    updateComposer();
    if (!client) return;
    const result = (await client.call("transcribe", [{ audio }])) as unknown as ActionResult<TranscriptResult>;
    if (!result.ok) {
      setNotice(result.error);
    } else if (!result.text) {
      setNotice("No speech was detected.");
    } else {
      ui.input.value = [ui.input.value.trim(), result.text].filter(Boolean).join("\n");
      ui.input.focus();
      if (result.source === "offline") setNotice("Offline mode returned a sample transcript, not your words.");
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

/**
 * Plays an item, or stops it when it is already selected. `speakingKey` is rechecked after the
 * request so a late response cannot play over a newer choice.
 */
async function toggleSpeech(kind: "review" | "message", id: string | number): Promise<void> {
  const key = `${kind}:${id}`;
  stopPlayback();
  if (speakingKey === key) {
    speakingKey = null;
    render();
    return;
  }
  if (!client) return;
  setNotice("");
  speakingKey = key;
  render();
  try {
    const result = (await client.call("speak", [{ kind, id }])) as unknown as ActionResult<SpeechResult>;
    if (speakingKey !== key) return;
    if (!result.ok) throw new Error(result.error);
    if (result.source === "offline") setNotice("Offline mode plays a test tone instead of speech.");
    await playAudio(result.audio, result.mimeType, () => {
      if (speakingKey === key) speakingKey = null;
      render();
    });
  } catch (error) {
    if (speakingKey === key) speakingKey = null;
    reportFailure(error);
    render();
  }
}

/** Opens the exception form for a finding. */
function openExceptionDialog(reviewId: string, finding: Finding): void {
  exceptionTarget = { reviewId, finding };
  ui.dialogTarget.textContent = `${finding.standardId} on ${finding.path}`;
  ui.dialogReason.value = "";
  ui.dialogError.textContent = "";
  ui.dialog.showModal();
  ui.dialogReason.focus();
}

/** Submits the exception form and keeps it open with the error on failure. */
async function saveException(): Promise<void> {
  if (!client || !exceptionTarget) return;
  const { reviewId, finding } = exceptionTarget;
  try {
    const result = (await client.call("acceptException", [{ reviewId, findingId: finding.id, reason: ui.dialogReason.value }])) as ActionResult;
    if (result.ok) ui.dialog.close();
    else ui.dialogError.textContent = result.error;
  } catch (error) {
    ui.dialogError.textContent = error instanceof Error ? error.message : "The exception was not saved.";
  }
}

/**
 * Calls a settings action. After a rejection the snapshot is refetched, which also restores a
 * checkbox the browser has already toggled.
 */
async function runAction(method: string, args: unknown[]): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.call(method, args)) as ActionResult;
    if (!result.ok) {
      setNotice(result.error);
      await refresh();
    }
  } catch (error) {
    reportFailure(error);
  }
}

/** Requests a change to a standard's enabled state. */
const toggleStandard = (id: string, enabled: boolean) => void runAction("setStandardEnabled", [{ id, enabled }]);
/** Requests removal of an exception. */
const revokeException = (id: string) => void runAction("revokeException", [{ id }]);

/**
 * Applies streamed text directly to the DOM, avoiding a full render per delta. A reset discards
 * partial text, which happens when a turn or Workflow step starts again.
 */
function handleLiveMessage(message: LiveMessage): void {
  if (message.type === "answer-reset" || message.type === "answer-delta") {
    liveAnswer = message.type === "answer-reset" ? "" : liveAnswer + message.delta;
    const answer = document.querySelector<HTMLElement>("#pending-answer .commentary");
    if (answer && liveAnswer) renderCommentary(answer, liveAnswer);
    if (isNearBottom()) scrollToEnd();
    return;
  }
  const previous = message.type === "commentary-delta" ? (liveCommentary.get(message.reviewId) ?? "") : "";
  const text = message.type === "commentary-delta" ? previous + message.delta : "";
  liveCommentary.set(message.reviewId, text);
  const target = document.querySelector<HTMLElement>(`[data-commentary="${message.reviewId}"]`);
  if (!target || !text) return;
  const follow = isNearBottom();
  renderCommentary(target, text);
  if (follow) scrollToEnd();
}

/** Updates the connection indicator. */
function setConnection(label: string, state: string): void {
  ui.status.textContent = label;
  ui.status.dataset.state = state;
}

/**
 * Switches to a repository, clearing all state from the previous connection.
 *
 * @param repository - Name already converted by `toSlug`.
 */
function connect(repository: string): void {
  client?.close();
  recording?.stop();
  stopPlayback();
  speakingKey = null;
  snapshot = null;
  guardState = null;
  seenRevision = -1;
  liveAnswer = "";
  submittingQuestion = false;
  liveCommentary.clear();
  ui.repoInput.value = repository;
  ui.timeline.replaceChildren();
  setConnection("Connecting", "connecting");
  try {
    localStorage.setItem("codex-guard-repo", repository);
  } catch {
    // The page works without saved preferences.
  }

  const next = new AgentClient<unknown, GuardState>({
    agent: "CodexGuardAgent",
    name: repository,
    host: location.host,
    protocol: location.protocol === "https:" ? "wss" : "ws",
    onStateUpdate: (state) => {
      guardState = state;
      // A new revision means stored data changed. Otherwise the current snapshot is redrawn.
      if (state.revision !== seenRevision) {
        seenRevision = state.revision;
        void refresh().catch(reportFailure);
      } else {
        render();
      }
    },
  });
  client = next;

  next.addEventListener("open", () => {
    if (client !== next) return;
    setConnection("Connected", "open");
    void refresh().catch(reportFailure);
  });
  next.addEventListener("close", () => {
    if (client === next) setConnection("Reconnecting", "connecting");
  });
  next.addEventListener("message", (event) => {
    // The socket also carries SDK frames, so a cheap test avoids parsing most of them.
    if (typeof event.data !== "string" || !/"(commentary|answer)-(delta|reset)"/.test(event.data)) return;
    try {
      const message = JSON.parse(event.data) as LiveMessage;
      if (["commentary-delta", "commentary-reset", "answer-delta", "answer-reset"].includes(message.type)) handleLiveMessage(message);
    } catch {
      // Ignore frames that are not application messages.
    }
  });
  updateComposer();
}

for (const sample of SAMPLES) {
  ui.samples.append(
    h(
      "button",
      {
        class: "chip",
        type: "button",
        onClick: () => {
          ui.input.value = sample.text;
          updateComposer();
          ui.input.focus();
        },
      },
      sample.label,
    ),
  );
}

ui.input.addEventListener("input", updateComposer);
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submitReview();
  }
});
ui.review.addEventListener("click", () => void submitReview());
ui.ask.addEventListener("click", () => void submitQuestion());
ui.mic.addEventListener("click", () => void toggleRecording());
ui.repoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const repository = toSlug(ui.repoInput.value);
  if (repository) connect(repository);
  else setNotice("Enter a repository name using letters, numbers, dots, dashes or underscores.");
});
ui.dialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveException();
});
ui.dialogCancel.addEventListener("click", () => ui.dialog.close());

connect(initialRepository());
