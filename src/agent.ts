import { Agent, callable, type StreamingResponse } from "agents";
import { buildSpokenReview, decodeWavInput, toSpokenText } from "./domain/audio";
import { normalizeText, parseChange, validateChangeInput, validateQuestion, validateReason } from "./domain/input";
import { buildQuestionPrompt, offlineAnswer } from "./domain/prompt";
import { containsInjectionLanguage, describeChange, redactSecrets } from "./domain/rules";
import { findStandard, SAMPLE_STANDARDS } from "./domain/standards";
import type {
  ActionResult,
  AiRouting,
  ChatMessage,
  CommentarySource,
  ExceptionRecord,
  GuardState,
  ReviewRecord,
  RuleResult,
  Snapshot,
  StandardSetting,
  StepName,
  StepStatus,
} from "./domain/types";
import { generateText, isOffline } from "./llm";
import { MODELS } from "./models";
import { synthesizeSpeech, transcribeAudio, type SpokenAudio, type Transcript } from "./speech";

const MAX_STORED_REVIEWS = 50;
const MAX_REVIEWS_PER_HOUR = 30;
const MAX_AI_ACTIONS_PER_HOUR = 60;
const STALE_REVIEW_MS = 10 * 60 * 1000;
const STEP_NAMES: readonly StepName[] = ["intake", "rules", "commentary", "save"];

type Row = Record<string, string | number | null>;

function initialSteps(): Record<StepName, StepStatus> {
  return { intake: "running", rules: "pending", commentary: "pending", save: "pending" };
}

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

function toException(row: Row): ExceptionRecord {
  return {
    id: String(row.id),
    standardId: String(row.standard_id),
    path: String(row.path),
    reason: String(row.reason),
    reviewId: String(row.review_id),
    createdAt: Number(row.created_at),
  };
}

/** One instance per repository. All of its memory lives in this Durable Object. */
export class CodexGuardAgent extends Agent<Env, GuardState> {
  override initialState: GuardState = { revision: 0, active: null };

  override async onStart(): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS standard_settings (
      id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      result_json TEXT, commentary TEXT NOT NULL DEFAULT '', commentary_source TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]', error TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS pending_inputs (
      review_id TEXT PRIMARY KEY, text TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS exceptions (
      id TEXT PRIMARY KEY, standard_id TEXT NOT NULL, path TEXT NOT NULL, reason TEXT NOT NULL,
      review_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (standard_id, path))`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      review_id TEXT, source TEXT, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS ai_actions (created_at INTEGER NOT NULL)`;
    if (!this.sql`SELECT name FROM pragma_table_info('reviews') WHERE name = 'model'`.length) {
      this.sql`ALTER TABLE reviews ADD COLUMN model TEXT`;
    }
    if (!this.sql`SELECT name FROM pragma_table_info('messages') WHERE name = 'model'`.length) {
      this.sql`ALTER TABLE messages ADD COLUMN model TEXT`;
    }
  }

  // Called from the browser ---------------------------------------------------

  @callable()
  getSnapshot(): Snapshot {
    this.failStaleReviews();
    const reviews = this.sql<Row>`SELECT * FROM reviews ORDER BY created_at DESC LIMIT ${MAX_STORED_REVIEWS}`;
    const messages = this.sql<Row>`SELECT * FROM messages ORDER BY id DESC LIMIT 200`;
    return {
      repository: this.name,
      routing: this.readRouting(),
      standards: this.readStandards(),
      exceptions: this.readExceptions(),
      reviews: reviews.map(toReview),
      messages: messages.reverse().map(
        (row): ChatMessage => ({
          id: Number(row.id),
          role: row.role as ChatMessage["role"],
          kind: row.kind as ChatMessage["kind"],
          text: String(row.text),
          reviewId: (row.review_id as string | null) ?? null,
          source: (row.source as CommentarySource | null) ?? null,
          model: (row.model as string | null) ?? null,
          createdAt: Number(row.created_at),
        }),
      ),
    };
  }

  @callable()
  async startReview(raw: unknown): Promise<ActionResult<{ reviewId: string }>> {
    const input = validateChangeInput(raw);
    if (!input.ok) return input;
    const parsed = parseChange(input.text);
    if (!parsed.ok) return parsed;

    this.failStaleReviews();
    const [running] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM reviews WHERE status = 'running'`;
    if ((running?.count ?? 0) > 0) return { ok: false, error: "A review is already running for this repository." };

    const hourAgo = Date.now() - 60 * 60 * 1000;
    const [recent] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM reviews WHERE created_at > ${hourAgo}`;
    if ((recent?.count ?? 0) >= MAX_REVIEWS_PER_HOUR) {
      return { ok: false, error: "This repository reached its hourly review limit. Try again later." };
    }

    const reviewId = crypto.randomUUID();
    const now = Date.now();
    const title = describeChange(parsed.change, input.text);
    const preview = redactSecrets(normalizeText(input.text)).slice(0, 280);
    this.sql`INSERT INTO reviews (id, created_at, status, title) VALUES (${reviewId}, ${now}, 'running', ${title})`;
    this.sql`INSERT INTO pending_inputs (review_id, text) VALUES (${reviewId}, ${input.text})`;
    this.sql`INSERT INTO messages (role, kind, text, review_id, created_at)
      VALUES ('user', 'review', ${preview}, ${reviewId}, ${now})`;
    this.publish({ reviewId, steps: initialSteps() });

    try {
      await this.runWorkflow("REVIEW_WORKFLOW", { reviewId, repository: this.name }, { id: reviewId });
    } catch (error) {
      console.error("workflow start failed", error instanceof Error ? error.message : "unknown error");
      this.markFailed(reviewId, "The review could not start. Try again.");
      return { ok: false, error: "The review could not start. Try again." };
    }
    return { ok: true, reviewId };
  }

  /** The finding is looked up on the server, so a client cannot invent one. */
  @callable()
  acceptException(reviewId: unknown, findingId: unknown, rawReason: unknown): ActionResult<{ exception: ExceptionRecord }> {
    if (typeof reviewId !== "string" || typeof findingId !== "string") {
      return { ok: false, error: "That finding was not found." };
    }
    const reason = validateReason(rawReason);
    if (!reason.ok) return reason;

    const [row] = this.sql<Row>`SELECT * FROM reviews WHERE id = ${reviewId}`;
    const finding = row ? toReview(row).result?.findings.find((item) => item.id === findingId) : undefined;
    if (!finding) return { ok: false, error: "That finding was not found." };
    if (!findStandard(finding.standardId)?.waivable) {
      return { ok: false, error: `${finding.standardId} cannot be waived. Fix the change instead.` };
    }

    const exception: ExceptionRecord = {
      id: crypto.randomUUID(),
      standardId: finding.standardId,
      path: finding.path,
      reason: redactSecrets(reason.text),
      reviewId,
      createdAt: Date.now(),
    };
    this.sql`INSERT INTO exceptions (id, standard_id, path, reason, review_id, created_at)
      VALUES (${exception.id}, ${exception.standardId}, ${exception.path}, ${exception.reason},
              ${exception.reviewId}, ${exception.createdAt})
      ON CONFLICT (standard_id, path) DO UPDATE SET
        id = excluded.id, reason = excluded.reason, review_id = excluded.review_id, created_at = excluded.created_at`;
    this.publish();
    return { ok: true, exception };
  }

  @callable()
  revokeException(id: unknown): ActionResult {
    if (typeof id !== "string") return { ok: false, error: "That exception was not found." };
    this.sql`DELETE FROM exceptions WHERE id = ${id}`;
    this.publish();
    return { ok: true };
  }

  @callable()
  setStandardEnabled(id: unknown, enabled: unknown): ActionResult {
    if (typeof id !== "string" || typeof enabled !== "boolean" || !findStandard(id)) {
      return { ok: false, error: "That standard was not found." };
    }
    if (!enabled && !findStandard(id)?.waivable) {
      return { ok: false, error: `${id} is mandatory and cannot be turned off.` };
    }
    const value = enabled ? 1 : 0;
    this.sql`INSERT INTO standard_settings (id, enabled) VALUES (${id}, ${value})
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled`;
    this.publish();
    return { ok: true };
  }

  @callable({ streaming: true })
  async ask(stream: StreamingResponse, raw: unknown): Promise<void> {
    const question = validateQuestion(raw);
    if (!question.ok) {
      stream.error(question.error);
      return;
    }
    if (!this.reserveAiAction()) {
      stream.error("This repository reached its hourly AI limit. Try again later.");
      return;
    }
    const now = Date.now();
    const shown = redactSecrets(normalizeText(question.text));
    this.sql`INSERT INTO messages (role, kind, text, created_at) VALUES ('user', 'text', ${shown}, ${now})`;
    this.publish();

    const [latest] = this.sql<Row>`SELECT * FROM reviews WHERE result_json IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
    const result = latest ? toReview(latest).result : null;
    try {
      const answer = await generateText(this.env, {
        messages: buildQuestionPrompt(question.text, result, crypto.randomUUID().replaceAll("-", "")),
        offlineText: offlineAnswer(result),
        maxOutputTokens: 700,
        gateway: {
          repository: this.name,
          feature: "question",
          ruleFlaggedInjection: containsInjectionLanguage(question.text),
        },
        onDelta: (delta) => {
          stream.send({ delta });
        },
      });
      const text = redactSecrets(answer.text);
      this.sql`INSERT INTO messages (role, kind, text, source, model, created_at)
        VALUES ('assistant', 'text', ${text}, ${answer.source}, ${answer.model}, ${Date.now()})`;
      this.publish();
      stream.end({ source: answer.source });
    } catch (error) {
      console.error("question failed", error instanceof Error ? error.message : "unknown error");
      stream.error("The model is unavailable right now. Rule results are unaffected.");
    }
  }

  /** The transcript returns to the composer, so the user can check it first. */
  @callable()
  async transcribe(raw: unknown): Promise<ActionResult<Transcript>> {
    const audio = decodeWavInput(raw);
    if (!audio.ok) return audio;
    if (!this.reserveAiAction()) return { ok: false, error: "This repository reached its hourly AI limit." };
    try {
      const transcript = await transcribeAudio(this.env, audio.bytes, {
        repository: this.name,
        feature: "transcription",
      });
      return { ok: true, ...transcript, text: redactSecrets(normalizeText(transcript.text)) };
    } catch (error) {
      console.error("transcription failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, error: "Speech recognition is unavailable right now." };
    }
  }

  /** Speaks stored content only, so this cannot become a general speech API. */
  @callable()
  async speak(kind: unknown, id: unknown): Promise<ActionResult<SpokenAudio>> {
    const target = this.readSpokenTarget(kind, id);
    if (!target) return { ok: false, error: "There is nothing to read aloud yet." };
    if (!this.reserveAiAction()) return { ok: false, error: "This repository reached its hourly AI limit." };
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

  // Called by ReviewWorkflow. Not @callable, so browsers cannot reach these ---

  loadReviewInput(reviewId: string): { text: string; standards: StandardSetting[]; exceptions: ExceptionRecord[] } {
    const [row] = this.sql<{ text: string }>`SELECT text FROM pending_inputs WHERE review_id = ${reviewId}`;
    if (!row) throw new Error("Review input is no longer available.");
    return { text: row.text, standards: this.readStandards(), exceptions: this.readExceptions() };
  }

  saveRuleResult(reviewId: string, result: RuleResult): void {
    const json = JSON.stringify(result);
    this.sql`UPDATE reviews SET result_json = ${json} WHERE id = ${reviewId}`;
    this.publish();
  }

  finishReview(
    reviewId: string,
    commentary: { text: string; source: CommentarySource; model: string | null; warnings: string[] },
  ): void {
    const warnings = JSON.stringify(commentary.warnings);
    this.sql`UPDATE reviews SET status = 'complete', commentary = ${commentary.text},
      commentary_source = ${commentary.source}, model = ${commentary.model},
      warnings_json = ${warnings} WHERE id = ${reviewId}`;
    // Kept until now so a retried rules step can read it again.
    this.sql`DELETE FROM pending_inputs WHERE review_id = ${reviewId}`;
    this.prune();
    this.publish(null);
  }

  // Workflow lifecycle --------------------------------------------------------

  override async onWorkflowProgress(_name: string, instanceId: string, progress: unknown): Promise<void> {
    const active = this.state.active;
    const update = progress as { step?: StepName; status?: StepStatus };
    if (active?.reviewId !== instanceId || !update.step || !update.status) return;
    if (!STEP_NAMES.includes(update.step)) return;
    this.publish({ reviewId: instanceId, steps: { ...active.steps, [update.step]: update.status } });
  }

  override async onWorkflowError(_name: string, instanceId: string, error: string): Promise<void> {
    console.error("review workflow failed", error);
    this.markFailed(instanceId, "The review could not finish. Try again.");
  }

  // Internals -----------------------------------------------------------------

  private publish(active: GuardState["active"] | undefined = undefined): void {
    this.setState({
      revision: this.state.revision + 1,
      active: active === undefined ? this.state.active : active,
    });
  }

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

  private readSpokenTarget(kind: unknown, id: unknown): { text: string; reviewId?: string } | null {
    if (kind === "review" && typeof id === "string") {
      const [row] = this.sql<Row>`SELECT * FROM reviews WHERE id = ${id}`;
      const review = row ? toReview(row) : null;
      return review?.result ? { text: buildSpokenReview(review.result, review.commentary), reviewId: id } : null;
    }
    if (kind === "message" && typeof id === "number") {
      const [row] = this.sql<{ text: string }>`SELECT text FROM messages WHERE id = ${id} AND role = 'assistant'`;
      const text = row ? toSpokenText(row.text) : "";
      return text ? { text } : null;
    }
    return null;
  }

  /** A per-repository brake. AI Gateway limits are the account-level control. */
  private reserveAiAction(): boolean {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.sql`DELETE FROM ai_actions WHERE created_at <= ${hourAgo}`;
    const [used] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM ai_actions`;
    if ((used?.count ?? 0) >= MAX_AI_ACTIONS_PER_HOUR) return false;
    this.sql`INSERT INTO ai_actions (created_at) VALUES (${Date.now()})`;
    return true;
  }

  private readStandards(): StandardSetting[] {
    const rows = this.sql<{ id: string; enabled: number }>`SELECT id, enabled FROM standard_settings`;
    const settings = new Map(rows.map((row) => [row.id, row.enabled === 1]));
    return SAMPLE_STANDARDS.map((standard) => ({
      ...standard,
      enabled: !standard.waivable || (settings.get(standard.id) ?? true),
    }));
  }

  private readExceptions(): ExceptionRecord[] {
    return this.sql<Row>`SELECT * FROM exceptions ORDER BY created_at DESC`.map(toException);
  }

  private markFailed(reviewId: string, message: string): void {
    this.sql`UPDATE reviews SET status = 'failed', error = ${message}
      WHERE id = ${reviewId} AND status = 'running'`;
    this.sql`DELETE FROM pending_inputs WHERE review_id = ${reviewId}`;
    this.publish(this.state.active?.reviewId === reviewId ? null : this.state.active);
  }

  private failStaleReviews(): void {
    const cutoff = Date.now() - STALE_REVIEW_MS;
    const stale = this.sql<{ id: string }>`SELECT id FROM reviews WHERE status = 'running' AND created_at < ${cutoff}`;
    for (const { id } of stale) this.markFailed(id, "The review timed out. Try again.");
  }

  private prune(): void {
    this.sql`DELETE FROM reviews WHERE id NOT IN (
      SELECT id FROM reviews ORDER BY created_at DESC LIMIT ${MAX_STORED_REVIEWS})`;
    this.sql`DELETE FROM messages WHERE review_id IS NOT NULL
      AND review_id NOT IN (SELECT id FROM reviews)`;
  }
}
