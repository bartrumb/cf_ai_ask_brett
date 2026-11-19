/*
 * Prompt-injection screening on a visitor's own words. AI Gateway Guardrails runs Cloudflare's
 * prompt-injection detector (P1), but it scans the whole request, and the system prompt's
 * anti-injection rules read as an attack, so on the main gateway it flagged every question.
 * Here only the question goes through a separate gateway that blocks on P1, so a block is a real
 * signal. The call asks for one token and its output is never used; it runs in the background and
 * never changes or delays the answer.
 */
import { gatewayMetadata } from "./gateway";
import { MODELS } from "./models";

/** What screening concluded. "unavailable" covers a missing gateway or any other failure. */
export type ScreenResult = "flagged" | "clear" | "unavailable";

/** AI Gateway's error for a prompt that Guardrails blocked. */
const PROMPT_BLOCKED = /\b2016\b|prompt blocked/i;

type ScreenEnv = { AI: Ai; SCREEN_GATEWAY_ID?: string };

/**
 * Screens one question.
 *
 * @param conversation - Recorded as gateway metadata so a flag can be found in the logs.
 */
export async function screenQuestion(env: ScreenEnv, question: string, conversation: string): Promise<ScreenResult> {
  const id = env.SCREEN_GATEWAY_ID;
  if (!id) return "unavailable";
  try {
    const output: unknown = await env.AI.run(
      MODELS.llm.primary as never,
      { messages: [{ role: "user", content: question }], max_tokens: 1 } as never,
      { gateway: { id, skipCache: true, collectLog: true, metadata: gatewayMetadata({ conversation, feature: "screening" }) } } as never,
    );
    // A block can also come back as an error inside the result instead of a thrown error.
    const text = output instanceof Response ? await output.text() : JSON.stringify(output ?? "");
    return PROMPT_BLOCKED.test(text) ? "flagged" : "clear";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (PROMPT_BLOCKED.test(message)) return "flagged";
    console.warn("screening unavailable", message.slice(0, 200));
    return "unavailable";
  }
}
