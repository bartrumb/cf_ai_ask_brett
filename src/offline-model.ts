/*
 * AI SDK model used for Think question turns in offline mode. Review commentary has its own offline
 * path in `llm.ts`.
 */
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";

/** Zero usage, since no model runs. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
/** Normal completion reported by every offline response. */
const FINISH = { unified: "stop" as const, raw: "stop" };

/**
 * A provider-compatible model that returns fixed text without any network call.
 *
 * @param text - Complete answer. Streaming splits it into word-sized deltas.
 */
export function createOfflineModel(text: string): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "codex-guard-offline",
    modelId: "offline-template",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: FINISH,
      usage: USAGE,
      warnings: [],
    }),
    doStream: async () => {
      const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        ...(text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: "text-delta" as const, id: "answer", delta })),
        { type: "text-end", id: "answer" },
        { type: "finish", usage: USAGE, finishReason: FINISH },
      ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
