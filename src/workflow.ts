/*
 * Durable pipeline for one review: run the rules, write optional commentary, save the outcome.
 *
 * `CodexGuardAgent` starts this Workflow and owns all stored data; each step reaches it over RPC.
 * The rule result is saved before any model call, so commentary can fail without affecting it.
 */
import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { CodexGuardAgent } from "./agent";
import { parseChange } from "./domain/input";
import { auditCommentary, buildReviewPrompt, offlineCommentary } from "./domain/prompt";
import { buildExcerpt, createStreamRedactor, evaluateChange, redactSecrets } from "./domain/rules";
import { reviewParamsSchema } from "./domain/schemas";
import type { CommentarySource, LiveMessage, RuleResult, StepName, StepStatus } from "./domain/types";
import { isGuardrailBlock } from "./gateway";
import { generateText } from "./llm";

/**
 * IDs only: Workflow params are stored, so raw input stays out. The agent holds the raw change, and
 * step results carry only rule results and the redacted excerpt.
 */
export interface ReviewParams {
  reviewId: string;
  repository: string;
}

/** Progress sent to `CodexGuardAgent.onWorkflowProgress`, which reads `step` and `status`. */
export interface ReviewProgress {
  step: StepName;
  status: StepStatus;
  [key: string]: unknown;
}

/** Commentary outcome saved with the review, including the unavailable case. */
interface Commentary {
  text: string;
  source: CommentarySource;
  model: string | null;
  warnings: string[];
}

/** Minimum gap between live broadcasts, since each one is an RPC to the agent. */
const FLUSH_INTERVAL_MS = 80;

/**
 * Runs one review. The instance ID equals the review ID.
 *
 * Code outside `step.do` can run again when the Workflow resumes, so progress reports may repeat.
 * Any error that escapes `run` reaches `CodexGuardAgent.onWorkflowError` and fails the review.
 */
export class ReviewWorkflow extends ThinkWorkflow<CodexGuardAgent, ReviewParams, ReviewProgress, Env> {
  /**
   * Executes the review steps in order.
   *
   * @returns The review ID and final risk.
   * @throws NonRetryableError if the stored input no longer parses; schema, step and RPC errors also
   * propagate. Commentary failures do not: they are recorded as unavailable.
   */
  override async run(event: AgentWorkflowEvent<ReviewParams>, step: ThinkWorkflowStep) {
    const { reviewId, repository } = reviewParamsSchema.parse(event.payload);

    await this.reportProgress({ step: "intake", status: "complete" });
    await this.reportProgress({ step: "rules", status: "running" });

    // Input is read inside the step so it never enters the Workflow params. The step's return
    // value is persisted, which is why it holds only redacted data.
    const rules = await step.do("run-deterministic-rules", async () => {
      const input = await this.agent.loadReviewInput(reviewId);
      const parsed = parseChange(input.text);
      if (!parsed.ok) throw new NonRetryableError(parsed.error);
      const result = evaluateChange(parsed.change, input);
      await this.agent.saveRuleResult(reviewId, result);
      return { result, excerpt: buildExcerpt(parsed.change) };
    });
    // Step output comes back as a serialized type, so the known shape is restored here.
    const result = rules.result as RuleResult;

    await this.reportProgress({ step: "rules", status: "complete" });
    await this.reportProgress({ step: "commentary", status: "running" });

    // Rule results are already saved, so a model failure cannot lose or alter them.
    let commentary: Commentary;
    try {
      commentary = await step.do(
        "write-ai-commentary",
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async (context) => {
          if (context.attempt > 1 && !(await this.agent.allowCommentaryRetry())) {
            throw new NonRetryableError("The AI budget does not allow another attempt.");
          }
          return this.writeCommentary(reviewId, repository, result, rules.excerpt);
        },
      );
    } catch (error) {
      console.error("commentary failed", error instanceof Error ? error.message : "unknown error");
      // Other failures are reported only through the unavailable source.
      const warnings = isGuardrailBlock(error) ? ["AI Gateway Guardrails blocked this commentary."] : [];
      commentary = { text: "", source: "unavailable", model: null, warnings };
    }

    await this.reportProgress({
      step: "commentary",
      status: commentary.source === "unavailable" ? "error" : "complete",
    });
    await this.reportProgress({ step: "save", status: "running" });

    await step.do("save-review", async () => {
      await this.agent.finishReview(reviewId, commentary);
    });

    await this.reportProgress({ step: "save", status: "complete" });
    await step.reportComplete({ reviewId, risk: result.risk });
    return { reviewId, risk: result.risk };
  }

  /**
   * Generates commentary while streaming batched deltas to clients.
   *
   * Each retry starts by resetting the client's partial text. Live and stored text are both redacted.
   * A Guardrails block is not retried, because the same prompt would be blocked again.
   *
   * @returns Commentary ready to store, with warnings from `auditCommentary`.
   * @throws Any model failure, so the surrounding step can retry.
   */
  private async writeCommentary(
    reviewId: string,
    repository: string,
    result: RuleResult,
    excerpt: string,
  ): Promise<Commentary> {
    // Broadcasts are not durable and the SDK does not return a promise for them.
    const send = (message: LiveMessage) => this.broadcastToClients(message);
    await send({ type: "commentary-reset", reviewId });

    const redactor = createStreamRedactor();
    let pending = "";
    let lastFlush = 0;
    const flush = async () => {
      if (!pending) return;
      const delta = pending;
      pending = "";
      lastFlush = Date.now();
      await send({ type: "commentary-delta", reviewId, delta });
    };

    const generated = await generateText(this.env, {
      // The review ID is created after the change is submitted, so the change cannot anticipate it.
      messages: buildReviewPrompt(result, excerpt, reviewId.replaceAll("-", "")),
      offlineText: offlineCommentary(result),
      maxOutputTokens: 1_800,
      gateway: {
        repository,
        feature: "review",
        reviewId,
        ruleFlaggedInjection: result.findings.some((finding) => finding.standardId === "STD-AGT-01"),
      },
      onDelta: async (delta) => {
        pending += redactor.push(delta);
        if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) await flush();
      },
    }).catch((error: unknown) => {
      if (isGuardrailBlock(error)) throw new NonRetryableError("Prompt blocked due to security configurations");
      throw error;
    });
    // Sends text still held back by the redactor and the flush interval.
    pending += redactor.finish();
    await flush();

    const text = redactSecrets(generated.text);
    return { text, source: generated.source, model: generated.model, warnings: auditCommentary(text, result) };
  }
}
