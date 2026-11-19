/*
 * Budget alerts. Every time a limit turns a visitor away, an `ask_budget_refused` event goes to
 * PostHog, where an alert notifies the owner. The project key comes from the optional
 * `POSTHOG_PROJECT_KEY` secret, so a fork sends nothing until its owner sets one. Events carry the
 * limit's name and count only: no address, question or conversation.
 */

/** PostHog's capture endpoint for US-region projects. */
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
/** Shared identity for these server events. Person profiles are switched off for it. */
const DISTINCT_ID = "ask-brett-worker";

/** Which limit refused, matching the `budget refused` log line. */
export type BudgetLimit = "per-minute" | "conversation-hourly" | "guarded-hourly" | "site-daily" | "visitor-daily";

type AlertEnv = { POSTHOG_PROJECT_KEY?: string };

/**
 * Sends one server event. Never throws: an alert that fails must not change the visitor's answer.
 * Callers pass only non-identifying properties.
 */
async function reportEvent(env: AlertEnv, event: string, properties: Record<string, string | number>): Promise<void> {
  const key = env.POSTHOG_PROJECT_KEY;
  if (!key) return;
  try {
    await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: DISTINCT_ID,
        properties: { ...properties, $process_person_profile: false, $lib: "ask-brett-worker" },
      }),
    });
  } catch (error) {
    console.warn("alert failed", error instanceof Error ? error.message : "unknown error");
  }
}

/**
 * Reports a refused action.
 *
 * @param used - Units already counted against the limit, where known.
 */
export function reportBudgetRefusal(env: AlertEnv, limit: BudgetLimit, used?: number): Promise<void> {
  return reportEvent(env, "ask_budget_refused", { limit, ...(used === undefined ? {} : { used }) });
}

/**
 * Reports a question the screening gateway blocked as prompt injection. Only its length is sent;
 * the text stays in the gateway log, found by the conversation ID in the Worker log.
 */
export function reportInjectionFlag(env: AlertEnv, length: number): Promise<void> {
  return reportEvent(env, "ask_injection_flagged", { length });
}
