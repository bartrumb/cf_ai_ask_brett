/*
 * Durable Object that owns one visitor's conversation with the AI advocate. Each browser gets its
 * own random instance. Questions enter Think's durable inbox, and the redacted conversation lives in
 * an app-owned SQLite table. Browsers reach only the `@callable` methods allowed by
 * `domain/schemas.ts`; one reserved instance also holds the shared daily budget.
 */
import { Think, type ChatResponseResult, type TurnConfig, type TurnContext } from "@cloudflare/think";
import { callable, getAgentByName, getCurrentAgent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { ACCESS_EXPIRES_HEADER, CLIENT_KEY_HEADER } from "./access";
import { decodeWav, toSpokenText } from "./domain/audio";
import { classifyQuestion, guardedAnswer } from "./domain/guards";
import { buildTurnPrompt, dropUnfinishedSentence, MAX_HISTORY_EXCHANGES, offlineAnswer, type Exchange } from "./domain/prompt";
import { createStreamRedactor, normalizeText, redactAnswer, redactSecrets } from "./domain/redaction";
import { allowedClientFrameId, parseInput, questionRequestSchema, speakRequestSchema, transcribeSchema } from "./domain/schemas";
import type { ActionResult, AnswerSource, ChatMessage, LiveMessage, ShowcaseState, Snapshot } from "./domain/types";
import type { GatewayContext } from "./gateway";
import { KNOWLEDGE_SECTIONS, PROFILE } from "./generated/knowledge";
import { createLanguageModel, isOffline } from "./llm";
import { createOfflineModel } from "./offline-model";
import { synthesizeSpeech, transcribeAudio, type SpokenAudio, type Transcript } from "./speech";

/** Questions, transcriptions and speech requests one conversation may make in a rolling hour. */
const MAX_AI_ACTIONS_PER_HOUR = 60;
/** Length of the rolling rate-limit window. */
const HOUR_MS = 60 * 60 * 1000;
/** Speech is charged more because one spoken answer can use many billed characters. */
const SPEECH_BUDGET_UNITS = 5;
/** Conversation data is deleted after this long without activity. */
const IDLE_RETENTION_MS = 30 * 24 * HOUR_MS;
/** How often a conversation with data checks whether it has gone idle. */
const IDLE_CHECK_SECONDS = 24 * 60 * 60;
/** Internal instance holding the daily budget. Its name can never pass the route check. */
const BUDGET_INSTANCE = "_daily-budget";
/** Longest over-budget frame that is parsed in order to send an error reply. */
const MAX_REJECTED_FRAME_CHARS = 1_024;
/** Conversation rows kept and returned. */
const MAX_STORED_MESSAGES = 200;
/** Burst of client calls allowed per connection. */
const FRAME_BURST = 60;
/** Client calls restored per connection each second. */
const FRAME_REFILL_PER_SECOND = 6;
/** Think chat frames. This client does not use them, and they would carry raw model output. */
const CHAT_PROTOCOL_FRAME = /^\{"type":"cf_agent_(?:use_chat|chat)_/;
/** Completed Think submissions are kept this long so retries stay idempotent. */
const SUBMISSION_RETENTION_MS = 7 * 24 * HOUR_MS;
/** Rows read when rebuilding recent exchanges. */
const HISTORY_ROWS = (MAX_HISTORY_EXCHANGES + 2) * 2;
/** Limits tied to one model turn. */
const MAX_OUTPUT_TOKENS = 700;
const TEMPERATURE = 0.2;
/** Stored as the answer when a turn fails or produces no text. */
const UNAVAILABLE_ANSWER = `I couldn't answer that just now. Please try again, or reach out at ${PROFILE.links.email}.`;
/** Shown when any spend limit refuses a request. */
const BUSY_MESSAGE = "This site has reached its limit for now. Please try again later.";

/** Identity saved on a connection from the Worker's verified headers. */
interface ConnectionIdentity {
  accessExpiresAt?: number;
  clientKey?: string | null;
}

/** Untyped SQLite row, narrowed by `toMessage`. */
type Row = Record<string, string | number | null>;

/** True for the frame kind that has its own read budget. */
function isSnapshotFrame(message: string): boolean {
  try {
    return (JSON.parse(message) as { method?: unknown }).method === "getSnapshot";
  } catch {
    return false;
  }
}

/** Maps a `messages` row to its client shape. */
function toMessage(row: Row): ChatMessage {
  return {
    id: Number(row.id),
    role: row.role as ChatMessage["role"],
    text: String(row.text),
    source: (row.source as AnswerSource | null) ?? null,
    createdAt: Number(row.created_at),
  };
}

/** Extracts the newest user text from a Think turn, or an empty string. */
function lastUserText(messages: TurnContext["messages"]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

/** One durable Think agent per browser conversation. */
export class ShowcaseAgent extends Think<Env, ShowcaseState> {
  /** Synced to every client. It carries a revision and progress, never conversation text. */
  override initialState: ShowcaseState = { revision: 0, activeQuestion: null };
  /** Turns have no tools, so one model step always ends them. */
  override maxSteps = 1;
  /** Keeps model reasoning out of Think's client stream. */
  override sendReasoning = false;
  /** Masks live answer text while a turn streams. */
  private answerRedactor = createStreamRedactor();
  /** Blocks a second question while the first is being written to Think's inbox. */
  private submittingQuestion = false;
  /** Per-connection call budgets. They are advisory and reset if the object is evicted. */
  private frameBudgets = new WeakMap<Connection, Record<"action" | "read", { tokens: number; updatedAt: number }>>();

  /**
   * Think installs its chat protocol handler immediately before calling onStart. Wrapping here keeps
   * this allowlist in front of that handler. Rejected frames get no reply, and allowed calls over
   * the connection budget get an RPC error.
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
      connection.setState({
        ...(expires > 0 ? { accessExpiresAt: expires } : {}),
        clientKey: context.request.headers.get(CLIENT_KEY_HEADER),
      });
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

  /** Installs the frame filter and creates tables. Every statement is safe to repeat. */
  override async onStart(): Promise<void> {
    this.installClientFrameFilter();
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      text TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS ai_actions (created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS daily_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS daily_client_budget (
      day TEXT NOT NULL, client TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (day, client))`;
    if (!this.getSchedules().some((schedule) => schedule.callback === "expireIdleData")) {
      await this.schedule(IDLE_CHECK_SECONDS, "expireIdleData", {}, { idempotent: true });
    }
  }

  /**
   * Browser clients can never write agent state directly. The frame filter already drops state
   * frames, so this is a second layer.
   *
   * @throws Error for any change that does not originate on the server.
   */
  override validateStateChange(_next: ShowcaseState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Agent state is read-only for clients.");
  }

  // Think turn configuration --------------------------------------------------

  /** Selects the offline or gateway-routed model for a question. */
  private modelFor(question: string) {
    if (isOffline(this.env)) return createOfflineModel(offlineAnswer(question, KNOWLEDGE_SECTIONS, PROFILE));
    const gateway: GatewayContext = { conversation: this.name, feature: "question" };
    return createLanguageModel(this.env, gateway);
  }

  /** Default model for Think. `beforeTurn` supplies the real one on every turn. */
  override getModel() {
    return this.modelFor("");
  }

  /** Default instructions. `beforeTurn` replaces them on every turn. */
  override getSystemPrompt(): string {
    return "You answer questions about a public professional profile.";
  }

  /**
   * Rebuilds every turn from profile facts, the newest question and recent redacted exchanges, with
   * no tools. Think calls this again for a recovered turn, so clients are told to reset partial text.
   */
  override beforeTurn(context: TurnContext): TurnConfig {
    this.answerRedactor = createStreamRedactor();
    this.sendLive({ type: "answer-reset" });
    const { pending, history } = this.readConversationTail();
    const question = lastUserText(context.messages) || pending;
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const { system, user } = buildTurnPrompt(question, history, KNOWLEDGE_SECTIONS, PROFILE, nonce);
    return {
      model: this.modelFor(question),
      instructions: system,
      messages: [{ role: "user", content: user }],
      activeTools: [],
      maxSteps: 1,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      sendReasoning: false,
    };
  }

  /** Streams redacted text. The held-back tail arrives with the stored answer. */
  override onChunk(context: Parameters<Think<Env, ShowcaseState>["onChunk"]>[0]): void {
    if (context.chunk.type !== "text-delta") return;
    const delta = this.answerRedactor.push(context.chunk.text);
    if (delta) this.sendLive({ type: "answer-delta", delta });
  }

  /**
   * Stores the finished answer and releases the question slot. Think calls this after the turn is
   * persisted and replays it after an interruption, so the row is keyed by request. Failed, aborted
   * and empty turns store a fixed message instead of partial text.
   */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const answer = result.message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    const succeeded = result.status === "completed" && answer.length > 0;
    const text = succeeded ? redactAnswer(dropUnfinishedSentence(answer)) : UNAVAILABLE_ANSWER;
    const source: AnswerSource = !succeeded ? "unavailable" : isOffline(this.env) ? "offline" : "workers-ai";
    // A real outcome replaces any placeholder written while this turn looked lost.
    this.sql`DELETE FROM messages WHERE id = (SELECT MAX(id) FROM messages) AND dedupe_key LIKE 'answer:recovered:%'`;
    this.sql`INSERT OR IGNORE INTO messages (dedupe_key, role, text, source, created_at)
      VALUES (${`answer:${result.requestId}`}, 'assistant', ${text}, ${source}, ${Date.now()})`;
    this.publish({ activeQuestion: null });
    this.prune();
    await this.schedule(1, "clearTranscript", {});
  }

  // Browser methods. schemas.ts lists the names that clients may call ----------

  /** Returns everything the page renders, and repairs a question whose turn has ended. */
  @callable()
  async getSnapshot(): Promise<Snapshot> {
    await this.clearFinishedQuestion();
    const rows = this.sql<Row>`SELECT * FROM messages ORDER BY id DESC LIMIT ${MAX_STORED_MESSAGES}`;
    return { offline: isOffline(this.env), messages: rows.reverse().map(toMessage) };
  }

  /**
   * Accepts a question. Guarded topics get a fixed answer with no model call. Others enter Think's
   * durable inbox under an idempotency key, so a reconnect retry cannot start a second paid turn.
   *
   * @param raw - Untrusted input matching `questionRequestSchema`.
   */
  @callable()
  async ask(raw: unknown): Promise<ActionResult<{ submissionId: string; accepted: boolean }>> {
    const input = parseInput(questionRequestSchema, raw);
    if (!input.ok) return input;
    const { question, requestId } = input.data;
    await this.clearFinishedQuestion();
    const key = `question:${requestId}`;
    const text = redactSecrets(normalizeText(question)).trim();
    const known = this.sql`SELECT id FROM messages WHERE dedupe_key = ${key}`.length > 0;
    // One question at a time keeps every answer directly after its question.
    if (!known && (this.state.activeQuestion || this.submittingQuestion)) {
      return { ok: false, error: "The previous question is still being answered." };
    }
    const category = classifyQuestion(question);
    if (category) {
      if (!known) {
        const now = Date.now();
        // No await separates these writes, so the pair commits together and stays adjacent.
        this.sql`INSERT INTO messages (dedupe_key, role, text, created_at) VALUES (${key}, 'user', ${text}, ${now})`;
        this.sql`INSERT INTO messages (dedupe_key, role, text, source, created_at)
          VALUES (${`answer:${key}`}, 'assistant', ${guardedAnswer(category, PROFILE)}, 'guarded', ${now})`;
        this.prune();
        this.publish();
      }
      return { ok: true, submissionId: `guarded:${requestId}`, accepted: !known };
    }

    // A retry skips the budget check because Think returns the original submission.
    if (!known) this.submittingQuestion = true;
    try {
      if (!known && !(await this.reserveAiAction())) return { ok: false, error: BUSY_MESSAGE };
      // The row is written first, so the answer always sorts after its question.
      this.sql`INSERT OR IGNORE INTO messages (dedupe_key, role, text, created_at)
        VALUES (${key}, 'user', ${text}, ${Date.now()})`;
      let submission;
      try {
        submission = await this.submitMessages(
          [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }],
          { idempotencyKey: key, metadata: { feature: "question" } },
        );
      } catch (error) {
        if (!known) this.sql`DELETE FROM messages WHERE dedupe_key = ${key}`;
        console.error("question submission failed", error instanceof Error ? error.message : "unknown error");
        return { ok: false, error: "The question could not be sent. Please try again." };
      }
      if (submission.accepted) this.publish({ activeQuestion: { submissionId: submission.submissionId } });
      else this.publish();
      return { ok: true, submissionId: submission.submissionId, accepted: submission.accepted };
    } finally {
      if (!known) this.submittingQuestion = false;
    }
  }

  /**
   * Converts a WAV recording to text for the visitor to check. A budget slot is consumed before the
   * call and is not returned on failure.
   *
   * @param raw - Untrusted input matching `transcribeSchema`.
   */
  @callable()
  async transcribe(raw: unknown): Promise<ActionResult<Transcript>> {
    const input = parseInput(transcribeSchema, raw);
    if (!input.ok) return input;
    const audio = decodeWav(input.data.audio);
    if (!audio.ok) return audio;
    if (!(await this.reserveAiAction())) return { ok: false, error: BUSY_MESSAGE };
    try {
      const transcript = await transcribeAudio(this.env, audio.bytes, { conversation: this.name, feature: "transcription" });
      return { ok: true, ...transcript, text: redactSecrets(normalizeText(transcript.text)) };
    } catch (error) {
      console.error("transcription failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, error: "Speech recognition is unavailable right now." };
    }
  }

  /**
   * Reads a stored answer aloud. It speaks stored content only, so this cannot become a general
   * speech API. Each call costs `SPEECH_BUDGET_UNITS`.
   *
   * @param raw - Untrusted input matching `speakRequestSchema`.
   */
  @callable()
  async speak(raw: unknown): Promise<ActionResult<SpokenAudio>> {
    const input = parseInput(speakRequestSchema, raw);
    if (!input.ok) return input;
    const [row] = this.sql<{ text: string }>`SELECT text FROM messages WHERE id = ${input.data.messageId} AND role = 'assistant'`;
    const text = row ? toSpokenText(row.text) : "";
    if (!text) return { ok: false, error: "There is nothing to read aloud yet." };
    if (!(await this.reserveAiAction(SPEECH_BUDGET_UNITS))) return { ok: false, error: BUSY_MESSAGE };
    try {
      return { ok: true, ...(await synthesizeSpeech(this.env, text, { conversation: this.name, feature: "speech" })) };
    } catch (error) {
      console.error("speech failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, error: "Speech is unavailable right now." };
    }
  }

  // Durable callbacks and internal RPC. These are not client-callable ----------

  /**
   * Claims units of today's shared AI budget. Runs only on the internal budget instance.
   *
   * @returns False when the global or per-visitor limit would be exceeded.
   */
  consumeDailyBudget(limit: number, units = 1, client?: string | null, clientLimit = limit): boolean {
    const day = new Date().toISOString().slice(0, 10);
    this.sql`DELETE FROM daily_budget WHERE day <> ${day}`;
    this.sql`DELETE FROM daily_client_budget WHERE day <> ${day}`;
    const [row] = this.sql<{ used: number }>`SELECT used FROM daily_budget WHERE day = ${day}`;
    if ((row?.used ?? 0) + units > limit) return false;
    if (client) {
      const [visitor] = this.sql<{ used: number }>`SELECT used FROM daily_client_budget WHERE day = ${day} AND client = ${client}`;
      if ((visitor?.used ?? 0) + units > clientLimit) return false;
      this.sql`INSERT INTO daily_client_budget (day, client, used) VALUES (${day}, ${client}, ${units})
        ON CONFLICT (day, client) DO UPDATE SET used = used + ${units}`;
    }
    this.sql`INSERT INTO daily_budget (day, used) VALUES (${day}, ${units})
      ON CONFLICT (day) DO UPDATE SET used = used + ${units}`;
    return true;
  }

  /**
   * Deletes conversation data after a long idle period. Empty conversations stop checking, so unused
   * IDs do not wake forever. A later start schedules the check again.
   */
  async expireIdleData(): Promise<void> {
    const [latest] = this.sql<{ at: number | null }>`SELECT MAX(created_at) AS at FROM messages`;
    if (latest?.at == null) return;
    if (Date.now() - latest.at < IDLE_RETENTION_MS) {
      await this.schedule(IDLE_CHECK_SECONDS, "expireIdleData", {});
      return;
    }
    while ((await this.deleteSubmissions({ limit: 100 })) > 0);
    await this.session.clearMessages();
    await this.syncMessagesFromStorage();
    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM ai_actions`;
    this.publish({ activeQuestion: null });
  }

  /**
   * Removes Think's copy of finished turns, so raw model text is neither replayed nor retained. The
   * redacted conversation stays in `messages`, and submission records keep retries idempotent.
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

  // Internals -----------------------------------------------------------------

  /** Broadcasts a transient message to every connection. Nothing is stored. */
  private sendLive(message: LiveMessage): void {
    this.broadcast(JSON.stringify(message));
  }

  /** Updates synced state and bumps the revision, which tells clients to refetch. */
  private publish(change: Partial<Pick<ShowcaseState, "activeQuestion">> = {}): void {
    for (const connection of this.getConnections()) this.closeIfExpired(connection);
    this.setState({ ...this.state, ...change, revision: this.state.revision + 1 });
  }

  /**
   * Reads recent rows as answered exchanges plus any unanswered final question. Fixed guard replies
   * and failures are left out, so refused topics never become model context.
   */
  private readConversationTail(): { pending: string; history: Exchange[] } {
    const rows = this.sql<Row>`SELECT * FROM messages ORDER BY id DESC LIMIT ${HISTORY_ROWS}`.reverse().map(toMessage);
    const history: Exchange[] = [];
    rows.forEach((row, index) => {
      const answer = rows[index + 1];
      if (row.role === "user" && answer?.role === "assistant" && (answer.source === "workers-ai" || answer.source === "offline")) {
        history.push({ question: row.text, answer: answer.text });
      }
    });
    const last = rows.at(-1);
    return { pending: last?.role === "user" ? last.text : "", history: history.slice(-MAX_HISTORY_EXCHANGES) };
  }

  /**
   * Applies shared limits across every conversation: a per-minute ceiling always, and daily budgets
   * for real model calls. Budget failures deny the action.
   */
  private async allowSharedAiSpend(units: number): Promise<boolean> {
    if (!(await this.env.AI_ACTION_LIMIT.limit({ key: "global" })).success) return false;
    if (isOffline(this.env)) return true;
    const limit = Number(this.env.DAILY_AI_ACTION_LIMIT);
    const clientLimit = Number(this.env.DAILY_CLIENT_AI_ACTION_LIMIT);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(clientLimit) || clientLimit <= 0) return false;
    const client = (getCurrentAgent().connection?.state as ConnectionIdentity | null | undefined)?.clientKey ?? null;
    try {
      const namespace = this.env.ShowcaseAgent as unknown as DurableObjectNamespace<ShowcaseAgent>;
      const budget = await getAgentByName<Env, ShowcaseAgent>(namespace, BUDGET_INSTANCE);
      return await budget.consumeDailyBudget(limit, units, client, clientLimit);
    } catch (error) {
      console.error("daily budget check failed", error instanceof Error ? error.message : "unknown error");
      return false;
    }
  }

  /**
   * Releases the question slot if Think's submission has ended or disappeared. If no answer was
   * stored, a fixed one is added so the visitor is never left waiting.
   */
  private async clearFinishedQuestion(): Promise<void> {
    const active = this.state.activeQuestion;
    if (!active) return;
    const submission = await this.inspectSubmission(active.submissionId);
    if (submission && ["pending", "running"].includes(submission.status)) return;
    const [last] = this.sql<{ role: string }>`SELECT role FROM messages ORDER BY id DESC LIMIT 1`;
    if (last?.role === "user") {
      this.sql`INSERT OR IGNORE INTO messages (dedupe_key, role, text, source, created_at)
        VALUES (${`answer:recovered:${active.submissionId}`}, 'assistant', ${UNAVAILABLE_ANSWER}, 'unavailable', ${Date.now()})`;
    }
    this.publish({ activeQuestion: null });
  }

  /**
   * Claims a slot in the conversation's hourly budget and then the shared budgets. Local refusal
   * comes first, so a conversation at its limit cannot drain the shared budget.
   *
   * @returns False when any budget is used up. A claimed slot is released only on refusal.
   */
  private async reserveAiAction(units = 1): Promise<boolean> {
    const hourAgo = Date.now() - HOUR_MS;
    this.sql`DELETE FROM ai_actions WHERE created_at <= ${hourAgo}`;
    const [used] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM ai_actions`;
    if ((used?.count ?? 0) >= MAX_AI_ACTIONS_PER_HOUR) return false;
    // The slot is held before the await, so concurrent calls cannot pass the hourly limit.
    const [slot] = this.sql<{ rowid: number }>`INSERT INTO ai_actions (created_at) VALUES (${Date.now()}) RETURNING rowid`;
    if (await this.allowSharedAiSpend(units)) return true;
    this.sql`DELETE FROM ai_actions WHERE rowid = ${slot?.rowid ?? -1}`;
    return false;
  }

  /** Caps stored conversation rows. */
  private prune(): void {
    this.sql`DELETE FROM messages WHERE id NOT IN (
      SELECT id FROM messages ORDER BY id DESC LIMIT ${MAX_STORED_MESSAGES})`;
  }
}
