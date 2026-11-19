import { createAI } from "agents/models/ai-sdk";
import { streamText } from "ai";
import type { PromptMessage } from "./domain/prompt";
import type { CommentarySource } from "./domain/types";
import { gatewayMetadata, type GatewayContext } from "./gateway";
import { MODELS } from "./models";

export interface GenerateOptions {
  messages: PromptMessage[];
  /** Text streamed instead of calling a model when AI_MODE is offline. */
  offlineText: string;
  maxOutputTokens: number;
  gateway: GatewayContext;
  onDelta: (delta: string) => void | Promise<void>;
}

export interface Generated {
  text: string;
  source: Exclude<CommentarySource, "unavailable">;
  model: string | null;
}

type LlmEnv = Pick<Env, "AI" | "AI_MODE" | "AI_GATEWAY_ID">;

export function isOffline(env: Pick<Env, "AI_MODE">): boolean {
  return env.AI_MODE === "offline";
}

async function streamOffline(text: string, onDelta: GenerateOptions["onDelta"]): Promise<void> {
  for (const piece of text.match(/\S+\s*/g) ?? []) {
    await onDelta(piece);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

export async function generateText(env: LlmEnv, options: GenerateOptions): Promise<Generated> {
  if (isOffline(env)) {
    await streamOffline(options.offlineText, options.onDelta);
    return { text: options.offlineText, source: "offline", model: null };
  }

  const ai = createAI({
    binding: env.AI,
    id: env.AI_GATEWAY_ID,
    skipCache: true,
    collectLog: true,
    metadata: gatewayMetadata(options.gateway),
  });
  let streamError: unknown;
  const result = streamText({
    model: ai(MODELS.llm.primary, {
      reasoningEffort: "low",
      // Used only when the primary fails before producing any output.
      fallback: [ai(MODELS.llm.secondary, { reasoningEffort: "low" })],
    }),
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
  const answeredBy = metadata?.cloudflare?.model;
  return { text, source: "workers-ai", model: typeof answeredBy === "string" ? answeredBy : MODELS.llm.primary };
}
