export const DEFAULT_GATEWAY_ID = "codex-guard";

type GuardrailAction = "FLAG" | "BLOCK";

export interface GatewaySettings {
  [key: string]: unknown;
  cache_invalidate_on_update: boolean;
  cache_ttl: number;
  collect_logs: boolean;
  rate_limiting_interval: number;
  rate_limiting_limit: number;
  rate_limiting_technique: string;
  guardrails: {
    prompt: Record<string, GuardrailAction>;
    response: Record<string, GuardrailAction>;
  };
}

const READ_ONLY_FIELDS = ["id", "account_id", "account_tag", "internal_id", "created_at", "modified_at"];

/**
 * Prompt injection (P1) is flagged, not blocked. This app reviews hostile diffs
 * on purpose, and blocking them would remove commentary where it helps most.
 * The update API replaces settings, so anything already configured is carried over.
 */
export function desiredGateway(existing?: Record<string, unknown>): GatewaySettings {
  const current = { ...existing };
  for (const field of READ_ONLY_FIELDS) delete current[field];
  const guardrails = (current.guardrails ?? {}) as Partial<GatewaySettings["guardrails"]>;
  return {
    cache_invalidate_on_update: false,
    cache_ttl: 0,
    rate_limiting_interval: 60,
    rate_limiting_limit: 120,
    rate_limiting_technique: "sliding",
    ...current,
    collect_logs: true,
    guardrails: {
      prompt: { P1: "FLAG", ...guardrails.prompt },
      response: { ...guardrails.response },
    },
  };
}
