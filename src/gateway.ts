/*
 * AI Gateway request options shared by language and speech calls, plus detection of Guardrails
 * blocks. Account-level gateway setup lives in `domain/gateway-config.ts`.
 */
/** App feature recorded with each gateway request. */
export type AiFeature = "review" | "question" | "transcription" | "speech";

/** Per-request details used for gateway log filtering. */
export interface GatewayContext {
  repository: string;
  feature: AiFeature;
  reviewId?: string;
  /** True when the deterministic rules saw text aimed at automated reviewers. */
  ruleFlaggedInjection?: boolean;
}

/**
 * Builds request metadata. AI Gateway keeps five metadata entries per request, so adding a field
 * means removing one.
 */
export function gatewayMetadata(context: GatewayContext): Record<string, string | boolean> {
  return {
    app: "codex-guard",
    repository: context.repository,
    feature: context.feature,
    review_id: context.reviewId ?? "none",
    rule_flagged_injection: context.ruleFlaggedInjection ?? false,
  };
}

/**
 * Builds the `gateway` option for direct `env.AI.run` calls, matching `createLanguageModel`: no
 * response cache, logging on.
 */
export function gatewayOptions(env: Pick<Env, "AI_GATEWAY_ID">, context: GatewayContext) {
  return {
    id: env.AI_GATEWAY_ID,
    skipCache: true,
    collectLog: true,
    metadata: gatewayMetadata(context),
  };
}

/**
 * Recognizes an AI Gateway Guardrails block from error text.
 * It matches codes 2016 and 2017 as whole words anywhere in the message or its cause, or the
 * standard block wording.
 */
export function isGuardrailBlock(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /\b(2016|2017)\b/.test(message) || /blocked due to security configurations/i.test(message);
}
