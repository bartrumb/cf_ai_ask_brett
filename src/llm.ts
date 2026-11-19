/*
 * Language-model access for the app. It builds gateway-routed models and generates streamed review
 * commentary, with an offline path that makes no network calls. Think question turns use
 * `createLanguageModel` directly; `ReviewWorkflow` uses `generateText`.
 */
import { createAI } from "agents/models/ai-sdk";
import { streamText } from "ai";
import type { PromptMessage } from "./domain/prompt";
import type { CommentarySource } from "./domain/types";
import { gatewayMetadata, type GatewayContext } from "./gateway";
import { MODELS } from "./models";

/** Inputs for one commentary generation. */
export interface GenerateOptions {
  /** Prompt from `buildReviewPrompt`, already delimited and redacted. */
  messages: PromptMessage[];
  /** Text streamed instead of calling a model when AI_MODE is offline. */
  offlineText: string;
  /** Upper bound on generated tokens. */
  maxOutputTokens: number;
  /** Metadata attached to the AI Gateway request. */
  gateway: GatewayContext;
  /** Receives each text fragment. A rejection aborts generation. */
  onDelta: (delta: string) => void | Promise<void>;
}

/** Completed text and where it came from. */
export interface Generated {
  text: string;
  source: Exclude<CommentarySource, "unavailable">;
  /** Model that answered, or null in offline mode. */
  model: string | null;
}

/** Bindings needed for model calls. */
type LlmEnv = Pick<Env, "AI" | "AI_MODE" | "AI_GATEWAY_ID">;

/** Returns true when `AI_MODE` selects templates instead of model calls. */
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
export function createLanguageModel(env: Pick<LlmEnv, "AI" | "AI_GATEWAY_ID">, gateway: GatewayContext) {
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

/** Emits offline text word by word, with a short delay so the UI streams as it does online. */
async function streamOffline(text: string, onDelta: GenerateOptions["onDelta"]): Promise<void> {
  for (const piece of text.match(/\S+\s*/g) ?? []) {
    await onDelta(piece);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

/**
 * Generates review commentary inside a retried Workflow step.
 *
 * @returns The full text, its source and the model that answered.
 * @throws Error when the stream fails or yields only whitespace, so the step can retry.
 */
export async function generateText(env: LlmEnv, options: GenerateOptions): Promise<Generated> {
  if (isOffline(env)) {
    await streamOffline(options.offlineText, options.onDelta);
    return { text: options.offlineText, source: "offline", model: null };
  }

  // `streamText` reports stream failures through `onError` instead of rejecting `textStream`.
  let streamError: unknown;
  const result = streamText({
    model: createLanguageModel(env, options.gateway),
    messages: options.messages,
    temperature: 0.2,
    maxOutputTokens: options.maxOutputTokens,
    onError: ({ error }) => {
      streamError = error;
    },
  });

  let text = "";
  for await (const delta of result.textStream) {
    text += delta;
    await options.onDelta(delta);
  }
  if (streamError) throw streamError instanceof Error ? streamError : new Error("Model stream failed.");
  if (!text.trim()) throw new Error("The model returned no text.");

  const metadata = await result.providerMetadata;
  // Names the fallback when it answered. The primary is assumed if the provider omits this.
  const answeredBy = metadata?.cloudflare?.model;
  return { text, source: "workers-ai", model: typeof answeredBy === "string" ? answeredBy : MODELS.llm.primary };
}
