import { createAI } from "agents/models/ai-sdk";
import { streamText } from "ai";
import type { PromptMessage } from "./domain/prompt";
import type { CommentarySource } from "./domain/types";

/** Current, non-deprecated Workers AI model: fast, inexpensive, 131k context. */
export const MODEL_ID = "@cf/zai-org/glm-4.7-flash";

export interface GenerateOptions {
  messages: PromptMessage[];
  /** Text streamed instead of calling a model when AI_MODE is offline. */
  offlineText: string;
  maxOutputTokens: number;
  onDelta: (delta: string) => void | Promise<void>;
}

export interface Generated {
  text: string;
  source: Exclude<CommentarySource, "unavailable">;
}

export function isOffline(env: Pick<Env, "AI_MODE">): boolean {
  return env.AI_MODE === "offline";
}

async function streamOffline(text: string, onDelta: GenerateOptions["onDelta"]): Promise<void> {
  for (const piece of text.match(/\S+\s*/g) ?? []) {
    await onDelta(piece);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

export async function generateText(env: Pick<Env, "AI" | "AI_MODE">, options: GenerateOptions): Promise<Generated> {
  if (isOffline(env)) {
    await streamOffline(options.offlineText, options.onDelta);
    return { text: options.offlineText, source: "offline" };
  }

  const ai = createAI({ binding: env.AI });
  let streamError: unknown;
  const result = streamText({
    model: ai(MODEL_ID, { reasoningEffort: "low" }),
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
  return { text, source: "workers-ai" };
}
