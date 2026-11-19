/*
 * Durable Object that owns one repository's Codex Guard memory and its browser API.
 *
 * It stores reviews, exceptions, standard settings and the visible chat log in SQLite, starts
 * `ReviewWorkflow` for each review, and answers follow-up questions through Think's durable
 * inbox. Rule logic lives in `domain/`, model access in `llm.ts` and `speech.ts`. Browsers reach
 * only the `@callable` methods allowed by `domain/schemas.ts`; the Workflow calls the others.
 */
import { Think, type ChatResponseResult, type StepContext, type TurnConfig, type TurnContext } from "@cloudflare/think";
import { callable, getAgentByName, getCurrentAgent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { ACCESS_EMAIL_HEADER, ACCESS_EXPIRES_HEADER } from "./access";
import { buildSpokenReview, decodeWav, toSpokenText } from "./domain/audio";
import { normalizeText, parseChange } from "./domain/input";
import { buildQuestionPrompt, offlineAnswer } from "./domain/prompt";
import { containsInjectionLanguage, createStreamRedactor, describeChange, isExceptionPath, redactSecrets } from "./domain/rules";
import {
  acceptExceptionSchema,
  allowedClientFrameId,
  parseInput,
  questionRequestSchema,
  reviewRequestSchema,
  revokeExceptionSchema,
  setStandardSchema,
  speakRequestSchema,
  transcribeSchema,
} from "./domain/schemas";
import { findStandard, SAMPLE_STANDARDS } from "./domain/standards";
import type {
  ActionResult,
  AiRouting,
  ChatMessage,
  CommentarySource,
  ExceptionRecord,
  GuardState,
  LiveMessage,
  ReviewRecord,
  RuleResult,
  Snapshot,
  StandardSetting,
  StepName,
  StepStatus,
} from "./domain/types";
import type { GatewayContext } from "./gateway";
import { createLanguageModel, isOffline } from "./llm";
import { MODELS } from "./models";
import { createOfflineModel } from "./offline-model";
import { synthesizeSpeech, transcribeAudio, type SpokenAudio, type Transcript } from "./speech";

/**
 * Reviews kept per repository. Keep this above `MAX_REVIEWS_PER_HOUR`, which counts stored rows.
 */
const MAX_STORED_REVIEWS = 50;
/** Reviews one repository may start in a rolling hour. */
const MAX_REVIEWS_PER_HOUR = 30;
/** Questions, transcriptions and speech requests one repository may make in a rolling hour. */
const MAX_AI_ACTIONS_PER_HOUR = 60;
/** Age at which a review still marked running is treated as abandoned. */
const STALE_REVIEW_MS = 20 * 60 * 1000;
/** Length of the rolling rate-limit window. */
const HOUR_MS = 60 * 60 * 1000;
/** Progress steps accepted from Workflow callbacks. */
/** Exceptions stop applying after this long and must be accepted again. */
const EXCEPTION_LIFETIME_MS = 90 * 24 * HOUR_MS;
/** Repository data is deleted after this long without activity. */
const IDLE_RETENTION_MS = 30 * 24 * HOUR_MS;
/** How often a repository with data checks whether it has gone idle. */
const IDLE_CHECK_SECONDS = 24 * 60 * 60;
/** Internal instance holding the daily budget. The leading underscore is not routable. */
const BUDGET_INSTANCE = "_daily-budget";
/** Longest over-budget frame that is parsed in order to send an error reply. */
const MAX_REJECTED_FRAME_CHARS = 1_024;
/** Plain chat rows kept per repository. */
const MAX_STORED_MESSAGES = 500;
/** Burst of client calls allowed per connection. */
const FRAME_BURST = 60;
/** Client calls restored per connection each second. */
const FRAME_REFILL_PER_SECOND = 6;
/** Think chat frames. This client does not use them, and they would carry raw model output. */
const CHAT_PROTOCOL_FRAME = /^\{"type":"cf_agent_(?:use_chat|chat)_/;
/** Completed Think submissions are kept this long so retries stay idempotent. */
const SUBMISSION_RETENTION_MS = 7 * 24 * HOUR_MS;
/** Snapshot reads have their own budget, so background refreshes cannot block user actions. */
function isSnapshotFrame(message: string): boolean {
  try {
    return (JSON.parse(message) as { method?: unknown }).method === "getSnapshot";
  } catch {
    return false;
  }
}

/** Identity saved on a connection by the Worker's verified headers. */
interface ConnectionIdentity {
  accessExpiresAt?: number;
  accessEmail?: string | null;
}
const STEP_NAMES: readonly StepName[] = ["intake", "rules", "commentary", "save"];
/** Stored as the answer when a question turn fails or produces no text. */
const UNAVAILABLE_ANSWER = "The model is unavailable right now. Rule results are unaffected.";

/** Untyped SQLite row, narrowed by the `to*` mappers below. */
type Row = Record<string, string | number | null>;

/** Returns the progress shown when a review starts; intake is already under way. */
function initialSteps(): Record<StepName, StepStatus> {
  return { intake: "running", rules: "pending", commentary: "pending", save: "pending" };
}

/**
 * Maps a `reviews` row to its client shape.
 *
 * @throws SyntaxError if a stored JSON column is corrupt. Only this class writes those columns.
 */
function toReview(row: Row): ReviewRecord {
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    status: row.status as ReviewRecord["status"],
    title: String(row.title),
    result: row.result_json ? (JSON.parse(String(row.result_json)) as RuleResult) : null,
    commentary: String(row.commentary ?? ""),
    commentarySource: (row.commentary_source as CommentarySource | null) ?? null,
    commentaryModel: (row.model as string | null) ?? null,
    commentaryWarnings: JSON.parse(String(row.warnings_json ?? "[]")) as string[],
    error: (row.error as string | null) ?? null,
  };
}

/** Maps an `exceptions` row to its client shape. */
function toException(row: Row): ExceptionRecord {
  return {
    id: String(row.id),
    standardId: String(row.standard_id),
    path: String(row.path),
    reason: String(row.reason),
    reviewId: String(row.review_id),
    createdAt: Number(row.created_at),
    createdBy: (row.created_by as string | null) ?? null,
  };
}

/** Maps a `messages` row to its client shape. */
function toMessage(row: Row): ChatMessage {
  return {
    id: Number(row.id),
    role: row.role as ChatMessage["role"],
    kind: row.kind as ChatMessage["kind"],
    text: String(row.text),
    reviewId: (row.review_id as string | null) ?? null,
    source: (row.source as CommentarySource | null) ?? null,
    model: (row.model as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

/**
 * Extracts the newest user text from a Think turn.
 *
 * @returns The joined text parts, or an empty string when the turn has no user message.
 */
function lastUserText(messages: TurnContext["messages"]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

/**
 * One durable Think agent per repository. Think owns the question inbox, turn
 * recovery and transcript. SQLite tables below hold the review domain data.
 */
export class CodexGuardAgent extends Think<Env, GuardState> {
  /** Synced to every client. It carries progress and a revision, never review content. */
  override initialState: GuardState = { revision: 0, active: null, activeQuestion: null };
  /** Question turns have no tools, so one model step always ends them. */
  override maxSteps = 1;
  /** Keeps model reasoning out of Think's client stream. */
  override sendReasoning = false;
  /**
   * Model that answered the current turn, as reported by the provider. It lives in memory only,
   * so `onChatResponse` falls back to the primary model ID after an eviction.
   */
  private answerModel: string | null = null;
  /** Masks live answer text while a turn streams. */
  private answerRedactor = createStreamRedactor();
  /** Blocks a second question while the first is being written to Think's inbox. */
  private submittingQuestion = false;
  /** Allows one review request at a time to spend shared budget before its row is written. */
  private startingReview = false;
  /** Per-connection call budgets. They are advisory and reset if the object is evicted. */
  private frameBudgets = new WeakMap<Connection, Record<"action" | "read", { tokens: number; updatedAt: number }>>();

  /**
   * Think installs its chat protocol handler immediately before calling
   * onStart. Wrapping here keeps this allowlist in front of that handler.
   * Rejected frames get no reply. Allowed calls over the connection budget get an RPC error.
   */
  private installClientFrameFilter(): void {
    const handleConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, context: ConnectionContext) => {
      // Think sends its transcript directly on connect, so broadcast filtering does not cover it.
      const send = connection.send.bind(connection);
      connection.send = (message) => {
        if (typeof message !== "string" || !CHAT_PROTOCOL_FRAME.test(message)) send(message);
      };
      const expires = Number(context.request.headers.get(ACCESS_EXPIRES_HEADER));
      if (expires > 0) {
        connection.setState({ accessExpiresAt: expires, accessEmail: context.request.headers.get(ACCESS_EMAIL_HEADER) });
      }
      return handleConnect(connection, context);
    };

    const handleMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (this.closeIfExpired(connection)) return;
      const small = typeof message === "string" && message.length <= MAX_REJECTED_FRAME_CHARS;
      const kind = small && isSnapshotFrame(message) ? "read" : "action";
      // The budget is checked first so an over-limit connection cannot force large frames to parse.
      if (!this.takeFrameToken(connection, kind)) {
        const id = small ? allowedClientFrameId(message) : null;
        if (id !== null) connection.send(JSON.stringify({ type: "rpc", id, success: false, error: "Too many requests." }));
        return;
      }
      if (allowedClientFrameId(message) === null) console.warn("rejected client frame");
      else await handleMessage(connection, message);
    };
  }

  /** Closes a connection whose Access token has expired. */
  private closeIfExpired(connection: Connection): boolean {
    const identity = connection.state as ConnectionIdentity | null;
    if (!identity?.accessExpiresAt || identity.accessExpiresAt > Date.now() / 1000) return false;
    connection.close(4401, "Access expired");
    return true;
  }

  /** Spends one token from the connection's refilling budget for this kind of call. */
  private takeFrameToken(connection: Connection, kind: "action" | "read"): boolean {
    const now = Date.now();
    const budgets = this.frameBudgets.get(connection) ?? {
      action: { tokens: FRAME_BURST, updatedAt: now },
      read: { tokens: FRAME_BURST, updatedAt: now },
    };
    this.frameBudgets.set(connection, budgets);
    const budget = budgets[kind];
    budget.tokens = Math.min(FRAME_BURST, budget.tokens + ((now - budget.updatedAt) / 1000) * FRAME_REFILL_PER_SECOND);
    budget.updatedAt = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  /** Drops Think's chat frames, which this client never reads. All other frames pass through. */
  override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
    if (typeof message === "string" && CHAT_PROTOCOL_FRAME.test(message)) return;
    for (const connection of this.getConnections()) this.closeIfExpired(connection);
    super.broadcast(message, without);
  }

  /**
   * Installs the frame filter, creates the domain tables and queues recovery of interrupted launches.
   * Runs on every Durable Object start, so each statement must be safe to repeat.
   */
  override async onStart(): Promise<void> {
    this.installClientFrameFilter();
    this.sql`CREATE TABLE IF NOT EXISTS standard_settings (
      id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      status TEXT NOT NULL, title TEXT NOT NULL, workflow_started INTEGER NOT NULL DEFAULT 0,
      result_json TEXT, commentary TEXT NOT NULL DEFAULT '', commentary_source TEXT, model TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]', error TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS pending_inputs (
      review_id TEXT PRIMARY KEY, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS exceptions (
      id TEXT PRIMARY KEY, standard_id TEXT NOT NULL, path TEXT NOT NULL, reason TEXT NOT NULL,
      review_id TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT, UNIQUE (standard_id, path))`;
    if (!this.sql`SELECT name FROM pragma_table_info('exceptions') WHERE name = 'created_by'`.length) {
      this.sql`ALTER TABLE exceptions ADD COLUMN created_by TEXT`;
    }
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, review_id TEXT, source TEXT, model TEXT,
      created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS ai_actions (created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS daily_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL)`;
    if (!this.getSchedules().some((schedule) => schedule.callback === "expireIdleData")) {
      await this.schedule(IDLE_CHECK_SECONDS, "expireIdleData", {});
    }

    // A review saved just before an eviction may have no Workflow yet. The launch runs as a
    // scheduled callback, so startup does not wait for Workflow creation.
    const [waiting] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM reviews
      WHERE status = 'running' AND workflow_started = 0`;
    if ((waiting?.count ?? 0) > 0) await this.schedule(0, "resumeUnstartedReviews", {});
  }

  /**
   * Browser clients can never write agent state directly. The frame filter already drops state
   * frames, so this is a second layer.
   *
   * @throws Error for any change that does not originate on the server.
   */
  override validateStateChange(_next: GuardState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Agent state is read-only for clients.");
  }

  // Think turn configuration --------------------------------------------------

  /**
   * Default model for Think. `beforeTurn` supplies its own model on every turn, including the
   * injection flag this default does not carry.
   */
  override getModel() {
    if (isOffline(this.env)) return createOfflineModel(offlineAnswer(this.latestResult()));
    return createLanguageModel(this.env, { repository: this.name, feature: "question" });
  }

  /**
   * Default instructions. `beforeTurn` replaces them with the prompt from `buildQuestionPrompt`.
   */
  override getSystemPrompt(): string {
    return "You answer questions about Codex Guard rule results. You cannot change those results.";
  }

  /**
   * Every turn is rebuilt from stored rule results and the newest question. It
   * has no tools and no earlier model text, which limits prompt-injection reach.
   * Think calls this again for a recovered turn, so clients are told to reset partial text.
   */
  override beforeTurn(context: TurnContext): TurnConfig {
    this.answerModel = null;
    this.answerRedactor = createStreamRedactor();
    this.sendLive({ type: "answer-reset" });
    const question = lastUserText(context.messages);
    const result = this.latestResult();
    // A fresh delimiter per turn, so submitted text cannot predict the closing tag.
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const [system, user] = buildQuestionPrompt(question, result, nonce);
    const gateway: GatewayContext = {
      repository: this.name,
      feature: "question",
      ruleFlaggedInjection: containsInjectionLanguage(question),
    };
    return {
      model: isOffline(this.env) ? createOfflineModel(offlineAnswer(result)) : createLanguageModel(this.env, gateway),
      instructions: system?.content ?? this.getSystemPrompt(),
      messages: [{ role: "user", content: user?.content ?? "" }],
      activeTools: [],
      maxSteps: 1,
      maxOutputTokens: 700,
      temperature: 0.2,
      sendReasoning: false,
    };
  }

  /**
   * Streams redacted answer text to every connected client. The tail stays buffered until
   * `onChatResponse` stores the complete redacted answer and clients refresh.
   */
  override onChunk(context: Parameters<Think<Env, GuardState>["onChunk"]>[0]): void {
    if (context.chunk.type === "text-delta") {
      const delta = this.answerRedactor.push(context.chunk.text);
      if (delta) this.sendLive({ type: "answer-delta", delta });
    }
  }

  /** Records which model answered, which may be the gateway-routed fallback. */
  override onStepEnd(context: StepContext): void {
    const model = context.providerMetadata?.cloudflare?.model;
    if (typeof model === "string") this.answerModel = model;
  }

  /**
   * Stores the finished answer and releases the question slot. Think calls this after the turn is
   * persisted and replays it after an interruption, so the stored answer is keyed by request.
   * Failed, aborted and empty turns store a fixed message instead of partial text.
   */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const answer = result.message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    const succeeded = result.status === "completed" && answer.length > 0;
    const offline = isOffline(this.env);
    const text = succeeded ? redactSecrets(answer) : UNAVAILABLE_ANSWER;
    const source: CommentarySource = !succeeded ? "unavailable" : offline ? "offline" : "workers-ai";
    const model = succeeded && !offline ? (this.answerModel ?? MODELS.llm.primary) : null;
    this.sql`INSERT OR IGNORE INTO messages (dedupe_key, role, kind, text, source, model, created_at)
      VALUES (${`answer:${result.requestId}`}, 'assistant', 'text', ${text}, ${source}, ${model}, ${Date.now()})`;
    this.publish({ activeQuestion: null });
    this.prune();
    await this.schedule(1, "clearTranscript", {});
  }

  // Browser methods. schemas.ts lists the names that clients may call ----------

  /**
   * Returns everything the UI renders. Clients call this whenever the state revision changes.
   * It also expires stale reviews and clears a finished question, so reads repair missed updates.
   */
  @callable()
  async getSnapshot(): Promise<Snapshot> {
    this.failStaleReviews();
    await this.clearFinishedQuestion();
    const reviews = this.sql<Row>`SELECT * FROM reviews ORDER BY created_at DESC LIMIT ${MAX_STORED_REVIEWS}`;
    const messages = this.sql<Row>`SELECT * FROM messages ORDER BY id DESC LIMIT 200`;
    return {
      repository: this.name,
      routing: this.readRouting(),
      standards: this.readStandards(),
      exceptions: this.readExceptions(),
      reviews: reviews.map(toReview),
      messages: messages.reverse().map(toMessage),
    };
  }

  /**
   * Validates a change, stores it and starts its Workflow.
   *
   * Repeating a request ID returns the original review instead of a new one. Only one review may
   * run per repository at a time.
   *
   * @param raw - Untrusted input matching `reviewRequestSchema`.
   * @returns The review ID, or a user-facing error. Validation, limit and launch failures do not throw.
   */
  @callable()
  async startReview(raw: unknown): Promise<ActionResult<{ reviewId: string }>> {
    const input = parseInput(reviewRequestSchema, raw);
    if (!input.ok) return input;
    const { text, requestId } = input.data;
    // Checked first so a retry gets its original answer even if a limit has since been reached.
    const [existing] = this.sql<{ id: string }>`SELECT id FROM reviews WHERE request_id = ${requestId}`;
    if (existing) return { ok: true, reviewId: existing.id };
    const parsed = parseChange(text);
    if (!parsed.ok) return parsed;

    this.failStaleReviews();
    const [running] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM reviews WHERE status = 'running'`;
    if ((running?.count ?? 0) > 0) return { ok: false, error: "A review is already running for this repository." };

    const hourAgo = Date.now() - HOUR_MS;
    const [recent] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM reviews WHERE created_at > ${hourAgo}`;
    if ((recent?.count ?? 0) >= MAX_REVIEWS_PER_HOUR) {
      return { ok: false, error: "This repository reached its hourly review limit. Try again later." };
    }
    if (this.startingReview) return { ok: false, error: "A review is already running for this repository." };
    this.startingReview = true;
    let allowed = false;
    try {
      allowed = await this.allowSharedAiSpend();
    } finally {
      this.startingReview = false;
    }
    if (!allowed) return { ok: false, error: "The service is busy. Try again shortly." };

    // Other requests can run during the await above, so both start conditions are checked again.
    const [raced] = this.sql<{ id: string }>`SELECT id FROM reviews WHERE request_id = ${requestId}`;
    if (raced) return { ok: true, reviewId: raced.id };
    const [runningNow] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM reviews WHERE status = 'running'`;
    if ((runningNow?.count ?? 0) > 0) return { ok: false, error: "A review is already running for this repository." };

    const reviewId = crypto.randomUUID();
    const now = Date.now();
    const title = describeChange(parsed.change, text);
    // The chat log keeps only this redacted preview. Raw text stays in `pending_inputs`.
    const preview = redactSecrets(normalizeText(text)).slice(0, 280);
    // No await separates these writes, so they commit together. They precede the launch so
    // `onStart` can resume it if the object is interrupted.
    this.sql`INSERT INTO reviews (id, request_id, created_at, status, title)
      VALUES (${reviewId}, ${requestId}, ${now}, 'running', ${title})`;
    this.sql`INSERT INTO pending_inputs (review_id, text) VALUES (${reviewId}, ${text})`;
    this.sql`INSERT INTO messages (dedupe_key, role, kind, text, review_id, created_at)
      VALUES (${`review:${requestId}`}, 'user', 'review', ${preview}, ${reviewId}, ${now})`;
    this.publish({ active: { reviewId, steps: initialSteps() } });

    return (await this.launchReview(reviewId))
      ? { ok: true, reviewId }
      : { ok: false, error: "The review could not start. Try again." };
  }

  /**
   * Records an exception for a finding's standard and file.
   *
   * The finding is looked up on the server, so a client cannot invent one. The exception applies
   * from the next review; stored results are not rewritten. A later exception for the same standard
   * and path replaces the earlier one.
   *
   * @param raw - Untrusted input matching `acceptExceptionSchema`.
   * @returns The stored exception, or an error for an unknown or non-waivable finding.
   */
  @callable()
  acceptException(raw: unknown): ActionResult<{ exception: ExceptionRecord }> {
    const input = parseInput(acceptExceptionSchema, raw);
    if (!input.ok) return input;
    const { reviewId, findingId, reason } = input.data;
    const [row] = this.sql<Row>`SELECT * FROM reviews WHERE id = ${reviewId}`;
    const finding = row ? toReview(row).result?.findings.find((item) => item.id === findingId) : undefined;
    if (!finding) return { ok: false, error: "That finding was not found." };
    if (!findStandard(finding.standardId)?.waivable) {
      return { ok: false, error: `${finding.standardId} cannot be waived. Fix the change instead.` };
    }
    if (!isExceptionPath(finding.path)) {
      return { ok: false, error: "This finding has no specific file to except. Fix the change instead." };
    }
    const actor = getCurrentAgent().connection?.state as ConnectionIdentity | null | undefined;
    const exception: ExceptionRecord = {
      id: crypto.randomUUID(),
      standardId: finding.standardId,
      path: finding.path,
      reason: redactSecrets(reason),
      reviewId,
      createdAt: Date.now(),
      createdBy: actor?.accessEmail ?? null,
    };
    this.sql`INSERT INTO exceptions (id, standard_id, path, reason, review_id, created_at, created_by)
      VALUES (${exception.id}, ${exception.standardId}, ${exception.path}, ${exception.reason},
              ${exception.reviewId}, ${exception.createdAt}, ${exception.createdBy ?? null})
      ON CONFLICT (standard_id, path) DO UPDATE SET
        id = excluded.id, reason = excluded.reason, review_id = excluded.review_id,
        created_at = excluded.created_at, created_by = excluded.created_by`;
    this.publish();
    return { ok: true, exception };
  }

  /**
   * Deletes an exception so future reviews report the finding again. Unknown IDs succeed silently.
   *
   * @param raw - Untrusted input matching `revokeExceptionSchema`.
   */
  @callable()
  revokeException(raw: unknown): ActionResult {
    const input = parseInput(revokeExceptionSchema, raw);
    if (!input.ok) return input;
    const [existing] = this.sql`SELECT id FROM exceptions WHERE id = ${input.data.id}`;
    if (!existing) return { ok: true };
    this.sql`DELETE FROM exceptions WHERE id = ${input.data.id}`;
    this.publish();
    return { ok: true };
  }

  /**
   * Turns a waivable standard on or off for future reviews. Mandatory standards cannot be disabled.
   *
   * @param raw - Untrusted input matching `setStandardSchema`.
   */
  @callable()
  setStandardEnabled(raw: unknown): ActionResult {
    const input = parseInput(setStandardSchema, raw);
    if (!input.ok) return input;
    const { id, enabled } = input.data;
    if (!enabled && !findStandard(id)?.waivable) {
      return { ok: false, error: `${id} is mandatory and cannot be turned off.` };
    }
    if (this.readStandards().find((standard) => standard.id === id)?.enabled === enabled) return { ok: true };
    const value = enabled ? 1 : 0;
    this.sql`INSERT INTO standard_settings (id, enabled) VALUES (${id}, ${value})
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`;
    this.publish();
    return { ok: true };
  }

  /**
   * Adds a question to Think's durable inbox and returns immediately. The
   * idempotency key makes reconnect retries safe and prevents a second paid turn.
   */
  @callable()
  async ask(raw: unknown): Promise<ActionResult<{ submissionId: string; accepted: boolean }>> {
    const input = parseInput(questionRequestSchema, raw);
    if (!input.ok) return input;
    const { question, requestId } = input.data;
    await this.clearFinishedQuestion();
    const idempotencyKey = `question:${requestId}`;
    const [known] = this.sql`SELECT id FROM messages WHERE dedupe_key = ${idempotencyKey}`;
    // A retry skips the busy and budget checks because Think returns the original submission
    // for the same key and starts no new turn.
    if (!known) {
      if (this.state.activeQuestion || this.submittingQuestion) {
        return { ok: false, error: "The previous question is still being answered." };
      }
    }
    if (!known) this.submittingQuestion = true;
    try {
      if (!known && !(await this.reserveAiAction())) {
        return { ok: false, error: "This repository reached its hourly AI limit." };
      }
      const text = redactSecrets(normalizeText(question));
      // The redacted text is what Think stores and what `beforeTurn` later reads.
      const submission = await this.submitMessages(
        [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }],
        { idempotencyKey, metadata: { feature: "question" } },
      );
      this.sql`INSERT OR IGNORE INTO messages (dedupe_key, role, kind, text, created_at)
        VALUES (${idempotencyKey}, 'user', 'text', ${text}, ${Date.now()})`;
      if (submission.accepted) this.publish({ activeQuestion: { submissionId: submission.submissionId } });
      return { ok: true, submissionId: submission.submissionId, accepted: submission.accepted };
    } finally {
      if (!known) this.submittingQuestion = false;
    }
  }

  /**
   * Converts a WAV recording to text. The transcript returns to the composer, so the user can check
   * it first. A budget slot is consumed before the call and is not returned on failure.
   *
   * @param raw - Untrusted input matching `transcribeSchema`.
   * @returns The redacted transcript, or a generic error if both speech models fail.
   */
  @callable()
  async transcribe(raw: unknown): Promise<ActionResult<Transcript>> {
    const input = parseInput(transcribeSchema, raw);
    if (!input.ok) return input;
    const audio = decodeWav(input.data.audio);
    if (!audio.ok) return audio;
    if (!(await this.reserveAiAction())) return { ok: false, error: "This repository reached its hourly AI limit." };
    try {
      const transcript = await transcribeAudio(this.env, audio.bytes, { repository: this.name, feature: "transcription" });
      return { ok: true, ...transcript, text: redactSecrets(normalizeText(transcript.text)) };
    } catch (error) {
      console.error("transcription failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, error: "Speech recognition is unavailable right now." };
    }
  }

  /**
   * Reads a stored review or assistant answer aloud. It speaks stored content only, so this cannot
   * become a general speech API. A budget slot is not returned on failure.
   *
   * @param raw - Untrusted input matching `speakRequestSchema`.
   * @returns Base64 audio, or an error when there is no target or both voice models fail.
   */
  @callable()
  async speak(raw: unknown): Promise<ActionResult<SpokenAudio>> {
    const input = parseInput(speakRequestSchema, raw);
    if (!input.ok) return input;
    const target = this.readSpokenTarget(input.data);
    if (!target) return { ok: false, error: "There is nothing to read aloud yet." };
    if (!(await this.reserveAiAction())) return { ok: false, error: "This repository reached its hourly AI limit." };
    try {
      const speech = await synthesizeSpeech(this.env, target.text, {
        repository: this.name,
        feature: "speech",
        reviewId: target.reviewId,
      });
      return { ok: true, ...speech };
    } catch (error) {
      console.error("speech failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, error: "Speech is unavailable right now." };
    }
  }

  // Durable callbacks and Workflow RPC. These are not client-callable ----------

  /**
   * Starts reviews whose row was saved before an interruption stopped launch. Invoked by name from
   * the schedule set in `onStart`. A launch that fails marks that review failed.
   */
  async resumeUnstartedReviews(): Promise<void> {
    const rows = this.sql<{ id: string }>`SELECT id FROM reviews WHERE status = 'running' AND workflow_started = 0`;
    for (const { id } of rows) await this.launchReview(id, true);
  }

  /** Charges a commentary retry, because each attempt can make new model calls. */
  allowCommentaryRetry(): Promise<boolean> {
    return this.allowSharedAiSpend();
  }

  /**
   * Claims one unit of today's account-wide AI budget. Runs only on the internal budget instance,
   * and is not client-callable.
   *
   * @returns False when the limit has been reached.
   */
  consumeDailyBudget(limit: number): boolean {
    const day = new Date().toISOString().slice(0, 10);
    this.sql`DELETE FROM daily_budget WHERE day <> ${day}`;
    const [row] = this.sql<{ used: number }>`SELECT used FROM daily_budget WHERE day = ${day}`;
    if ((row?.used ?? 0) >= limit) return false;
    this.sql`INSERT INTO daily_budget (day, used) VALUES (${day}, 1)
      ON CONFLICT (day) DO UPDATE SET used = used + 1`;
    return true;
  }

  /**
   * Deletes repository data after a long idle period. Empty repositories stop checking, so unused
   * names do not wake forever. A later connection schedules the check again.
   */
  async expireIdleData(): Promise<void> {
    const [latest] = this.sql<{ at: number | null }>`SELECT MAX(at) AS at FROM (
      SELECT MAX(created_at) AS at FROM reviews
      UNION ALL SELECT MAX(created_at) FROM messages
      UNION ALL SELECT MAX(created_at) FROM exceptions)`;
    if (latest?.at == null) return;
    if (Date.now() - latest.at < IDLE_RETENTION_MS) {
      await this.schedule(IDLE_CHECK_SECONDS, "expireIdleData", {});
      return;
    }
    while ((await this.deleteSubmissions({ limit: 100 })) > 0);
    await this.session.clearMessages();
    await this.syncMessagesFromStorage();
    this.sql`DELETE FROM reviews`;
    this.sql`DELETE FROM pending_inputs`;
    this.sql`DELETE FROM exceptions`;
    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM standard_settings`;
    this.sql`DELETE FROM ai_actions`;
    this.publish({ active: null, activeQuestion: null });
  }

  /**
   * Removes Think's copy of finished turns. Answers are rebuilt from rule results, and the redacted
   * conversation lives in `messages`, so this keeps raw model text from being replayed or retained.
   * Think keeps submission records separately, so idempotency still works.
   */
  async clearTranscript(): Promise<void> {
    const submissions = await this.listSubmissions();
    if (submissions.some((submission) => ["pending", "running"].includes(submission.status))) {
      await this.schedule(5, "clearTranscript", {});
      return;
    }
    await this.deleteSubmissions({ completedBefore: new Date(Date.now() - SUBMISSION_RETENTION_MS) });
    await this.session.clearMessages();
    await this.syncMessagesFromStorage();
  }

  /**
   * Gives the Workflow the raw change plus the current standards and exceptions.
   *
   * @throws Error when the input is gone because the review already ended.
   */
  loadReviewInput(reviewId: string): { text: string; standards: StandardSetting[]; exceptions: ExceptionRecord[] } {
    const [row] = this.sql<{ text: string }>`SELECT text FROM pending_inputs WHERE review_id = ${reviewId}`;
    if (!row) throw new Error("Review input is no longer available.");
    return { text: row.text, standards: this.readStandards(), exceptions: this.readExceptions() };
  }

  /** Persists the rule result before any model call. Safe to repeat when the step retries. */
  saveRuleResult(reviewId: string, result: RuleResult): void {
    const json = JSON.stringify(result);
    this.sql`UPDATE reviews SET result_json = ${json} WHERE id = ${reviewId}`;
    this.publish();
  }

  /**
   * Marks a running review complete, deletes its raw input and prunes old history. It is safe to
   * repeat, and a review already failed as stale keeps that status. Only this review's progress is
   * cleared, so a newer active review is left alone.
   */
  finishReview(
    reviewId: string,
    commentary: { text: string; source: CommentarySource; model: string | null; warnings: string[] },
  ): void {
    const warnings = JSON.stringify(commentary.warnings);
    this.sql`UPDATE reviews SET status = 'complete', commentary = ${commentary.text},
      commentary_source = ${commentary.source}, model = ${commentary.model},
      warnings_json = ${warnings} WHERE id = ${reviewId} AND status = 'running'`;
    // Kept until now so a retried rules step can read it again.
    this.sql`DELETE FROM pending_inputs WHERE review_id = ${reviewId}`;
    this.prune();
    if (this.state.active?.reviewId === reviewId) this.publish({ active: null });
    else this.publish();
  }

  /**
   * Applies a Workflow progress callback to the synced step list. Callbacks run outside durable
   * steps and can repeat, so anything for a review that is no longer active is ignored.
   */
  override async onWorkflowProgress(_name: string, instanceId: string, progress: unknown): Promise<void> {
    const active = this.state.active;
    const update = progress as { step?: StepName; status?: StepStatus };
    if (active?.reviewId !== instanceId || !update.step || !update.status) return;
    if (!STEP_NAMES.includes(update.step)) return;
    this.publish({ active: { reviewId: instanceId, steps: { ...active.steps, [update.step]: update.status } } });
  }

  /** Fails the review when `ReviewWorkflow.run` throws. The detailed error is logged, not shown. */
  override async onWorkflowError(_name: string, instanceId: string, error: string): Promise<void> {
    console.error("review workflow failed", error);
    this.markFailed(instanceId, "The review could not finish. Try again.");
  }

  // Internals -----------------------------------------------------------------

  /** Broadcasts a transient message to every connection. Nothing is stored. */
  private sendLive(message: LiveMessage): void {
    this.broadcast(JSON.stringify(message));
  }

  /**
   * Updates synced state and bumps the revision. Call after every change to stored data, because
   * clients use the new revision as their signal to refetch the snapshot.
   */
  private publish(change: Partial<Pick<GuardState, "active" | "activeQuestion">> = {}): void {
    for (const connection of this.getConnections()) this.closeIfExpired(connection);
    this.setState({ ...this.state, ...change, revision: this.state.revision + 1 });
  }

  /** Returns the newest saved rule result, including one from a review still running. */
  private latestResult(): RuleResult | null {
    const [latest] = this.sql<Row>`SELECT * FROM reviews WHERE result_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
    return latest ? toReview(latest).result : null;
  }

  /**
   * Starts the Workflow, using the review ID as its instance ID so callbacks map back to the review.
   *
   * @param resuming - True after a restart, when an earlier attempt may already have created it.
   * @returns False after a start failure. The review is then marked failed.
   */
  private async launchReview(reviewId: string, resuming = false): Promise<boolean> {
    try {
      await this.runWorkflow("REVIEW_WORKFLOW", { reviewId, repository: this.name }, { id: reviewId });
    } catch (error) {
      const alreadyCreated = resuming && (await this.workflowExists(reviewId));
      if (!alreadyCreated) {
        console.error("workflow start failed", error instanceof Error ? error.message : "unknown error");
        this.markFailed(reviewId, "The review could not start. Try again.");
        return false;
      }
    }
    this.sql`UPDATE reviews SET workflow_started = 1 WHERE id = ${reviewId}`;
    return true;
  }

  /**
   * Applies shared limits across every repository name: a per-minute ceiling always, and a daily
   * budget for real model calls. Budget failures deny the action.
   */
  private async allowSharedAiSpend(): Promise<boolean> {
    if (!(await this.env.AI_ACTION_LIMIT.limit({ key: "global" })).success) return false;
    if (isOffline(this.env)) return true;
    const limit = Number(this.env.DAILY_AI_ACTION_LIMIT);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    try {
      const namespace = this.env.CodexGuardAgent as unknown as DurableObjectNamespace<CodexGuardAgent>;
      const budget = await getAgentByName<Env, CodexGuardAgent>(namespace, BUDGET_INSTANCE);
      return await budget.consumeDailyBudget(limit);
    } catch (error) {
      console.error("daily budget check failed", error instanceof Error ? error.message : "unknown error");
      return false;
    }
  }

  /** True when a Workflow instance with this ID already exists. */
  private async workflowExists(reviewId: string): Promise<boolean> {
    try {
      await this.env.REVIEW_WORKFLOW.get(reviewId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Releases the question slot if Think's submission has ended or disappeared. This covers turns
   * whose `onChatResponse` did not clear it.
   */
  private async clearFinishedQuestion(): Promise<void> {
    const active = this.state.activeQuestion;
    if (!active) return;
    const submission = await this.inspectSubmission(active.submissionId);
    if (!submission || !["pending", "running"].includes(submission.status)) this.publish({ activeQuestion: null });
  }

  /** Describes the configured model routing for display. It contains no secrets. */
  private readRouting(): AiRouting {
    return {
      offline: isOffline(this.env),
      gatewayId: this.env.AI_GATEWAY_ID,
      models: [
        { label: "Language model", ...MODELS.llm },
        { label: "Speech to text", ...MODELS.stt },
        { label: "Text to speech", ...MODELS.tts },
      ],
    };
  }

  /**
   * Resolves a speech request to stored text. Message targets are limited to assistant messages.
   *
   * @returns The text to speak, or null when the target is missing, unfinished or empty.
   */
  private readSpokenTarget(target: { kind: "review"; id: string } | { kind: "message"; id: number }) {
    if (target.kind === "review") {
      const [row] = this.sql<Row>`SELECT * FROM reviews WHERE id = ${target.id}`;
      const review = row ? toReview(row) : null;
      return review?.result ? { text: buildSpokenReview(review.result, review.commentary), reviewId: target.id } : null;
    }
    const [row] = this.sql<{ text: string }>`SELECT text FROM messages WHERE id = ${target.id} AND role = 'assistant'`;
    const text = row ? toSpokenText(row.text) : "";
    return text ? { text, reviewId: undefined } : null;
  }

  /**
   * Claims one slot in the repository's hourly budget and then the shared budgets. Local refusal
   * comes first, so a repository at its limit cannot drain the shared budget.
   *
   * @returns False when either budget is used up. A claimed slot is never returned.
   */
  private async reserveAiAction(): Promise<boolean> {
    const hourAgo = Date.now() - HOUR_MS;
    this.sql`DELETE FROM ai_actions WHERE created_at <= ${hourAgo}`;
    const [used] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM ai_actions`;
    if ((used?.count ?? 0) >= MAX_AI_ACTIONS_PER_HOUR) return false;
    // The slot is held before the await, so concurrent calls cannot pass the hourly limit.
    const [slot] = this.sql<{ rowid: number }>`INSERT INTO ai_actions (created_at) VALUES (${Date.now()}) RETURNING rowid`;
    if (await this.allowSharedAiSpend()) return true;
    this.sql`DELETE FROM ai_actions WHERE rowid = ${slot?.rowid ?? -1}`;
    return false;
  }

  /**
   * Merges stored settings over the catalog. Standards default to enabled, and mandatory standards
   * stay enabled whatever is stored.
   */
  private readStandards(): StandardSetting[] {
    const rows = this.sql<{ id: string; enabled: number }>`SELECT id, enabled FROM standard_settings`;
    const settings = new Map(rows.map((row) => [row.id, row.enabled === 1]));
    return SAMPLE_STANDARDS.map((standard) => ({
      ...standard,
      enabled: !standard.waivable || (settings.get(standard.id) ?? true),
    }));
  }

  /** Returns every recorded exception, newest first. */
  private readExceptions(): ExceptionRecord[] {
    const cutoff = Date.now() - EXCEPTION_LIFETIME_MS;
    this.sql`DELETE FROM exceptions WHERE created_at <= ${cutoff}`;
    return this.sql<Row>`SELECT * FROM exceptions ORDER BY created_at DESC`.map(toException);
  }

  /**
   * Fails a running review and deletes its raw input. A review that already ended keeps its status,
   * and the active slot is released only if it belongs to this review.
   */
  private markFailed(reviewId: string, message: string): void {
    this.sql`UPDATE reviews SET status = 'failed', error = ${message}
      WHERE id = ${reviewId} AND status = 'running'`;
    this.sql`DELETE FROM pending_inputs WHERE review_id = ${reviewId}`;
    if (this.state.active?.reviewId === reviewId) this.publish({ active: null });
    else this.publish();
  }

  /**
   * Fails running reviews older than `STALE_REVIEW_MS`. This does not stop their Workflow instances.
   */
  private failStaleReviews(): void {
    const cutoff = Date.now() - STALE_REVIEW_MS;
    const stale = this.sql<{ id: string }>`SELECT id FROM reviews WHERE status = 'running' AND created_at < ${cutoff}`;
    for (const { id } of stale) this.markFailed(id, "The review timed out. Try again.");
  }

  /**
   * Trims reviews to `MAX_STORED_REVIEWS`, removes their messages and caps plain chat history.
   */
  private prune(): void {
    this.sql`DELETE FROM reviews WHERE id NOT IN (
      SELECT id FROM reviews ORDER BY created_at DESC LIMIT ${MAX_STORED_REVIEWS})`;
    this.sql`DELETE FROM messages WHERE review_id IS NOT NULL
      AND review_id NOT IN (SELECT id FROM reviews)`;
    this.sql`DELETE FROM messages WHERE id NOT IN (
      SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_STORED_MESSAGES})`;
  }
}
