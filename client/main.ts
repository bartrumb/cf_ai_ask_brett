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

const MAX_INPUT_CHARS = 40_000;
const DEFAULT_REPO = "sample-payments-api";
const STEP_LABELS: Record<StepName, string> = {
  intake: "Input accepted",
  rules: "Rules evaluated",
  commentary: "AI commentary",
  save: "Saved to memory",
};

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | boolean | EventListener | undefined>;

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

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const ui = {
  timeline: byId<HTMLElement>("timeline"),
  scroller: byId<HTMLElement>("chat-scroll"),
  input: byId<HTMLTextAreaElement>("change-input"),
  count: byId<HTMLElement>("char-count"),
  samples: byId<HTMLElement>("samples"),
  review: byId<HTMLButtonElement>("review-button"),
  ask: byId<HTMLButtonElement>("ask-button"),
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

let client: AgentClient<unknown, GuardState> | null = null;
let snapshot: Snapshot | null = null;
let guardState: GuardState | null = null;
let seenRevision = -1;
let pendingAnswer: { question: string; text: string } | null = null;
let exceptionTarget: { reviewId: string; finding: Finding } | null = null;
const liveCommentary = new Map<string, string>();

function toSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
}

function initialRepository(): string {
  const fromUrl = toSlug(new URLSearchParams(location.search).get("repo") ?? "");
  if (fromUrl) return fromUrl;
  try {
    return toSlug(localStorage.getItem("codex-guard-repo") ?? "") || DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}

function setNotice(message: string): void {
  ui.notice.textContent = message;
  ui.notice.hidden = !message;
}

function isNearBottom(): boolean {
  const { scrollHeight, scrollTop, clientHeight } = ui.scroller;
  return scrollHeight - scrollTop - clientHeight < 120;
}

function scrollToEnd(): void {
  ui.scroller.scrollTop = ui.scroller.scrollHeight;
}

function isBusy(): boolean {
  return Boolean(guardState?.active) || pendingAnswer !== null;
}

function updateComposer(): void {
  const length = ui.input.value.length;
  const hasText = ui.input.value.trim().length > 0;
  ui.count.textContent = `${length.toLocaleString("en-US")} / ${MAX_INPUT_CHARS.toLocaleString("en-US")}`;
  ui.count.classList.toggle("over", length > MAX_INPUT_CHARS);
  const blocked = !client || isBusy() || !hasText || length > MAX_INPUT_CHARS;
  ui.review.disabled = blocked;
  ui.ask.disabled = blocked || length > 2_000;
}

function sourceLabel(source: CommentarySource | null): string {
  if (source === "offline") return "Offline template, no model called";
  if (source === "unavailable") return "Unavailable";
  return snapshot?.modelLabel ?? "Workers AI";
}

/** Renders the commentary format as text nodes, with headings for readability. */
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

function stepper(steps: Record<StepName, StepStatus>): HTMLElement {
  const names = Object.keys(STEP_LABELS) as StepName[];
  return h(
    "ol",
    { class: "steps", "aria-label": "Review progress" },
    ...names.map((name) => h("li", { class: `step ${steps[name]}` }, h("span", { class: "dot" }), STEP_LABELS[name])),
  );
}

function hasExceptionOnFile(finding: Finding): boolean {
  return Boolean(snapshot?.exceptions.some((e) => e.standardId === finding.standardId && e.path === finding.path));
}

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
    h("p", { class: "checked" }, sourceLabel(review.commentarySource)),
  );
}

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

function messageNode(message: ChatMessage, reviews: Map<string, ReviewRecord>): Child[] {
  if (message.kind === "review") {
    const review = message.reviewId ? reviews.get(message.reviewId) : undefined;
    return [h("div", { class: "bubble user" }, h("pre", {}, message.text)), review && reviewCard(review)];
  }
  if (message.role === "user") return [h("div", { class: "bubble user" }, message.text)];
  const body = h("div", { class: "commentary" });
  renderCommentary(body, message.text);
  return [h("div", { class: "bubble assistant" }, h("span", { class: "bubble-label" }, `AI answer · ${sourceLabel(message.source)}`), body)];
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    h("h2", {}, "Check a change before you open the pull request"),
    h("p", {}, "Paste a unified diff or describe the change. Fixed rules set the risk and pick the standards. The model explains the findings and suggests fixes, and it cannot change the result."),
    h("p", { class: "muted" }, "Pick a sample below to see it work."),
  );
}

function render(): void {
  if (!snapshot) return;
  const follow = isNearBottom();
  const reviews = new Map(snapshot.reviews.map((review) => [review.id, review]));
  const nodes = snapshot.messages.flatMap((message) => messageNode(message, reviews)).filter((node): node is Node | string => Boolean(node));
  if (pendingAnswer) {
    const body = h("div", { class: "commentary" });
    renderCommentary(body, pendingAnswer.text || "Thinking…");
    if (!snapshot.messages.some((m) => m.role === "user" && m.kind === "text" && m.text === pendingAnswer?.question)) {
      nodes.push(h("div", { class: "bubble user" }, pendingAnswer.question));
    }
    nodes.push(h("div", { class: "bubble assistant", id: "pending-answer" }, h("span", { class: "bubble-label" }, "AI answer"), body));
  }
  ui.timeline.replaceChildren(...(nodes.length ? nodes : [emptyState()]));
  renderSidebar();
  updateComposer();
  if (follow) scrollToEnd();
}

function renderSidebar(): void {
  if (!snapshot) return;
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

async function refresh(): Promise<void> {
  if (!client) return;
  const current = client;
  const next = (await current.call("getSnapshot")) as unknown as Snapshot;
  if (current !== client) return;
  snapshot = next;
  for (const review of next.reviews) if (review.status !== "running") liveCommentary.delete(review.id);
  render();
}

function reportFailure(error: unknown): void {
  setNotice(error instanceof Error ? error.message : "Something went wrong.");
}

async function submitReview(): Promise<void> {
  if (!client || ui.review.disabled) return;
  setNotice("");
  ui.review.disabled = true;
  try {
    const result = (await client.call("startReview", [ui.input.value])) as ActionResult;
    if (!result.ok) setNotice(result.error);
    else ui.input.value = "";
  } catch (error) {
    reportFailure(error);
  }
  updateComposer();
}

function submitQuestion(): void {
  if (!client || ui.ask.disabled) return;
  setNotice("");
  const question = ui.input.value.trim();
  pendingAnswer = { question, text: "" };
  ui.input.value = "";
  render();
  scrollToEnd();
  const finish = () => {
    pendingAnswer = null;
    void refresh().catch(reportFailure);
  };
  client
    .call("ask", [question], {
      stream: {
        onChunk: (chunk) => {
          if (!pendingAnswer) return;
          pendingAnswer.text += (chunk as { delta?: string }).delta ?? "";
          const body = document.querySelector<HTMLElement>("#pending-answer .commentary");
          if (body) renderCommentary(body, pendingAnswer.text);
          scrollToEnd();
        },
        onDone: finish,
        onError: (message) => {
          setNotice(message);
          finish();
        },
      },
    })
    .catch(reportFailure);
}

function openExceptionDialog(reviewId: string, finding: Finding): void {
  exceptionTarget = { reviewId, finding };
  ui.dialogTarget.textContent = `${finding.standardId} on ${finding.path}`;
  ui.dialogReason.value = "";
  ui.dialogError.textContent = "";
  ui.dialog.showModal();
  ui.dialogReason.focus();
}

async function saveException(): Promise<void> {
  if (!client || !exceptionTarget) return;
  const { reviewId, finding } = exceptionTarget;
  try {
    const result = (await client.call("acceptException", [reviewId, finding.id, ui.dialogReason.value])) as ActionResult;
    if (result.ok) ui.dialog.close();
    else ui.dialogError.textContent = result.error;
  } catch (error) {
    ui.dialogError.textContent = error instanceof Error ? error.message : "The exception was not saved.";
  }
}

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

const toggleStandard = (id: string, enabled: boolean) => void runAction("setStandardEnabled", [id, enabled]);
const revokeException = (id: string) => void runAction("revokeException", [id]);

function handleLiveMessage(message: LiveMessage): void {
  const previous = message.type === "commentary-delta" ? (liveCommentary.get(message.reviewId) ?? "") : "";
  const text = message.type === "commentary-delta" ? previous + message.delta : "";
  liveCommentary.set(message.reviewId, text);
  const target = document.querySelector<HTMLElement>(`[data-commentary="${message.reviewId}"]`);
  if (!target || !text) return;
  const follow = isNearBottom();
  renderCommentary(target, text);
  if (follow) scrollToEnd();
}

function setConnection(label: string, state: string): void {
  ui.status.textContent = label;
  ui.status.dataset.state = state;
}

function connect(repository: string): void {
  client?.close();
  snapshot = null;
  guardState = null;
  seenRevision = -1;
  pendingAnswer = null;
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
    if (typeof event.data !== "string" || !event.data.includes('"commentary-')) return;
    try {
      const message = JSON.parse(event.data) as LiveMessage;
      if (message.type === "commentary-delta" || message.type === "commentary-reset") handleLiveMessage(message);
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
ui.ask.addEventListener("click", submitQuestion);
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
