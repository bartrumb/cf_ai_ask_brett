/*
 * AI Gateway request options shared by language and speech calls. Account-level gateway setup lives
 * in `domain/gateway-config.ts`.
 */
/** App feature recorded with each gateway request. */
export type AiFeature = "question" | "transcription" | "speech";

/** Per-request details used for gateway log filtering. */
export interface GatewayContext {
  conversation: string;
  feature: AiFeature;
}

/** Builds request metadata. AI Gateway keeps at most five metadata entries per request. */
export function gatewayMetadata(context: GatewayContext): Record<string, string> {
  return { app: "ask-brett", conversation: context.conversation, feature: context.feature };
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
