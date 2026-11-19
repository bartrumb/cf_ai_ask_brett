import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { CodexGuardAgent } from "./agent";
import { parseChange } from "./domain/input";
import { auditCommentary, buildReviewPrompt, offlineCommentary } from "./domain/prompt";
import { buildExcerpt, evaluateChange, redactSecrets } from "./domain/rules";
import { reviewParamsSchema } from "./domain/schemas";
import type { CommentarySource, LiveMessage, RuleResult, StepName, StepStatus } from "./domain/types";
import { isGuardrailBlock } from "./gateway";
import { generateText } from "./llm";

/** IDs only: Workflow params and step results are stored, so raw input stays out. */
export interface ReviewParams {
  reviewId: string;
  repository: string;
}

export interface ReviewProgress {
  step: StepName;
  status: StepStatus;
  [key: string]: unknown;
}

interface Commentary {
  text: string;
  source: CommentarySource;
  model: string | null;
  warnings: string[];
}

const FLUSH_INTERVAL_MS = 80;

export class ReviewWorkflow extends ThinkWorkflow<CodexGuardAgent, ReviewParams, ReviewProgress, Env> {
  override async run(event: AgentWorkflowEvent<ReviewParams>, step: ThinkWorkflowStep) {
    const { reviewId, repository } = reviewParamsSchema.parse(event.payload);

    await this.reportProgress({ step: "intake", status: "complete" });
    await this.reportProgress({ step: "rules", status: "running" });

    const rules = await step.do("run-deterministic-rules", async () => {
      const input = await this.agent.loadReviewInput(reviewId);
      const parsed = parseChange(input.text);
      if (!parsed.ok) throw new NonRetryableError(parsed.error);
      const result = evaluateChange(parsed.change, input);
      await this.agent.saveRuleResult(reviewId, result);
      return { result, excerpt: buildExcerpt(parsed.change) };
    });
    const result = rules.result as RuleResult;

    await this.reportProgress({ step: "rules", status: "complete" });
    await this.reportProgress({ step: "commentary", status: "running" });

    // Rule results are already saved, so a model failure cannot lose or alter them.
    let commentary: Commentary;
    try {
      commentary = await step.do(
        "write-ai-commentary",
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        () => this.writeCommentary(reviewId, repository, result, rules.excerpt),
      );
    } catch (error) {
      console.error("commentary failed", error instanceof Error ? error.message : "unknown error");
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

  private async writeCommentary(
    reviewId: string,
    repository: string,
    result: RuleResult,
    excerpt: string,
  ): Promise<Commentary> {
    const send = (message: LiveMessage) => this.broadcastToClients(message);
    await send({ type: "commentary-reset", reviewId });

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
        pending += delta;
        if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) await flush();
      },
    });
    await flush();

    const text = redactSecrets(generated.text);
    return { text, source: generated.source, model: generated.model, warnings: auditCommentary(text, result) };
  }
}
