import { z } from "zod";

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

export const gatewayEnvironmentSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string({ error: "Set CLOUDFLARE_ACCOUNT_ID first." }).regex(/^[a-f0-9]{32}$/, {
    error: "CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID.",
  }),
  CLOUDFLARE_API_TOKEN: z.string({ error: "Set CLOUDFLARE_API_TOKEN first." }).regex(/^[A-Za-z0-9_-]{20,}$/, {
    error: "CLOUDFLARE_API_TOKEN does not look like an API token.",
  }),
  AI_GATEWAY_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "AI_GATEWAY_ID may use lowercase letters, numbers and dashes." })
    .default(DEFAULT_GATEWAY_ID),
});

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

interface ApiResult {
  status: number;
  ok: boolean;
  body: { success?: boolean; result?: Record<string, unknown>; errors?: { message?: string }[] };
}

/**
 * Creates or updates the gateway. The token is only placed in the request
 * header, and error messages contain only what the Cloudflare API returns.
 */
export async function applyGateway(rawEnvironment: unknown, fetcher: typeof fetch = fetch): Promise<"created" | "updated"> {
  const parsed = gatewayEnvironmentSchema.safeParse(rawEnvironment);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "The environment is not valid.");
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token, AI_GATEWAY_ID: gatewayId } = parsed.data;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`;

  const request = async (path: string, init: RequestInit = {}): Promise<ApiResult> => {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as ApiResult["body"];
    return { status: response.status, ok: response.ok && body.success !== false, body };
  };
  const requireSuccess = (result: ApiResult, action: string) => {
    if (result.ok) return;
    const detail = result.body.errors?.map((error) => error.message).filter(Boolean).join("; ") || "no details returned";
    throw new Error(`Could not ${action} (HTTP ${result.status}): ${detail}`);
  };

  const existing = await request(`/${gatewayId}`);
  if (existing.status === 404) {
    const body = JSON.stringify({ id: gatewayId, ...desiredGateway() });
    requireSuccess(await request("", { method: "POST", body }), "create the gateway");
    return "created";
  }
  requireSuccess(existing, "read the gateway");
  const body = JSON.stringify(desiredGateway(existing.body.result));
  requireSuccess(await request(`/${gatewayId}`, { method: "PUT", body }), "update the gateway");
  return "updated";
}
