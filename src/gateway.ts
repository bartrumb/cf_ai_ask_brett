export type AiFeature = "review" | "question" | "transcription" | "speech";

export interface GatewayContext {
  repository: string;
  feature: AiFeature;
  reviewId?: string;
  /** True when the deterministic rules saw text aimed at automated reviewers. */
  ruleFlaggedInjection?: boolean;
}

/** AI Gateway keeps five metadata entries per request. */
export function gatewayMetadata(context: GatewayContext): Record<string, string | boolean> {
  return {
    app: "codex-guard",
    repository: context.repository,
    feature: context.feature,
    review_id: context.reviewId ?? "none",
    rule_flagged_injection: context.ruleFlaggedInjection ?? false,
  };
}

export function gatewayOptions(env: Pick<Env, "AI_GATEWAY_ID">, context: GatewayContext) {
  return {
    id: env.AI_GATEWAY_ID,
    skipCache: true,
    collectLog: true,
    metadata: gatewayMetadata(context),
  };
}

export function isGuardrailBlock(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /\b(2016|2017)\b/.test(message) || /blocked due to security configurations/i.test(message);
}
