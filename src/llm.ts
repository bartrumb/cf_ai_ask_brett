/*
 * Language-model access for Think turns. Every model is routed through AI Gateway, and offline mode
 * never constructs one.
 */
import { createAI } from "agents/models/ai-sdk";
import { gatewayMetadata, type GatewayContext } from "./gateway";
import { MODELS } from "./models";

/** Returns true when `AI_MODE` selects local answers instead of model calls. */
export function isOffline(env: Pick<Env, "AI_MODE">): boolean {
  return env.AI_MODE === "offline";
}

/**
 * Builds the primary model, with the secondary as a gateway-routed fallback.
 *
 * Response caching is skipped and gateway logging is on for every call.
 *
 * @param gateway - Metadata recorded with each gateway request.
 */
export function createLanguageModel(env: Pick<Env, "AI" | "AI_GATEWAY_ID">, gateway: GatewayContext) {
  const ai = createAI({
    binding: env.AI,
    id: env.AI_GATEWAY_ID,
    skipCache: true,
    collectLog: true,
    metadata: gatewayMetadata(gateway),
  });
  return ai(MODELS.llm.primary, {
    reasoningEffort: "low",
    // Used only when the primary fails before producing any output.
    fallback: [ai(MODELS.llm.secondary, { reasoningEffort: "low" })],
  });
}
