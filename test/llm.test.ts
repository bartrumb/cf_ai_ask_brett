import { describe, expect, it, vi } from "vitest";
import { createLanguageModel, isOffline } from "../src/llm";
import { MODELS } from "../src/models";

describe("language model", () => {
  it("recognizes offline mode", () => {
    expect(isOffline({ AI_MODE: "offline" })).toBe(true);
    expect(isOffline({ AI_MODE: "workers-ai" })).toBe(false);
  });

  it("routes the primary model through the configured gateway with app metadata", async () => {
    const run = vi.fn(async (_model: string, _input: unknown, _options: unknown) => ({ response: "Hello", usage: {} }));
    const model = createLanguageModel({ AI: { run } as unknown as Ai, AI_GATEWAY_ID: "test-gateway" }, { conversation: "c1", feature: "question" });
    await Promise.resolve(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] } as never)).catch(() => undefined);
    expect(run).toHaveBeenCalled();
    const [name, , options] = run.mock.calls[0] as [string, unknown, { gateway?: { id?: string; skipCache?: boolean; metadata?: Record<string, string> } }];
    expect(name).toBe(MODELS.llm.primary);
    expect(options.gateway).toMatchObject({ id: "test-gateway", skipCache: true, metadata: { app: "ask-brett", conversation: "c1", feature: "question" } });
  });
});
