/*
 * Desired AI Gateway configuration and the Cloudflare API calls that apply it. Used only by
 * `scripts/setup-gateway.mjs`; the Worker reads just the gateway ID at runtime.
 */
import { z } from "zod";

/** Gateway name used when `AI_GATEWAY_ID` is not set. Matches `wrangler.jsonc`. */
export const DEFAULT_GATEWAY_ID = "codex-guard";
/** Screening gateway name used when `SCREEN_GATEWAY_ID` is not set. Matches `wrangler.jsonc`. */
export const DEFAULT_SCREEN_GATEWAY_ID = "ask-brett-screen";

/** Action AI Gateway Guardrails takes for a category. */
type GuardrailAction = "FLAG" | "BLOCK";

/** Gateway fields this app sets. The index signature preserves fields it does not manage. */
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

/**
 * Validates the setup script's environment. Error messages never include the supplied values, so
 * a malformed token cannot reach the console.
 */
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
  SCREEN_GATEWAY_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "SCREEN_GATEWAY_ID may use lowercase letters, numbers and dashes." })
    .default(DEFAULT_SCREEN_GATEWAY_ID),
});

/** Fields the API returns but does not accept back on update. */
const READ_ONLY_FIELDS = ["id", "account_id", "account_tag", "internal_id", "created_at", "modified_at"];

/** Copies settings the update API will accept back, dropping read-only and null fields. */
function carryOver(existing?: Record<string, unknown>): Record<string, unknown> {
  const current = { ...existing };
  for (const field of READ_ONLY_FIELDS) delete current[field];
  // The API reports an unset limit as null, which must not override the safe defaults.
  for (const [field, value] of Object.entries(current)) if (value === null) delete current[field];
  return current;
}

/** Defaults shared by both gateways: no response cache and a per-minute ceiling. */
const BASE_SETTINGS = {
  cache_invalidate_on_update: false,
  cache_ttl: 0,
  rate_limiting_interval: 60,
  rate_limiting_limit: 120,
  rate_limiting_technique: "sliding",
};

/**
 * The main gateway, which carries every model call. It has no prompt-injection check (P1):
 * Guardrails scans the whole prompt, and this app's system prompt contains anti-injection rules
 * that the detector reads as an attack, so it flagged every request and cost time on each one.
 * Injection is screened on the visitor's own words through the screening gateway instead.
 * The update API replaces settings, so anything else already configured is carried over, and log
 * collection is always forced on.
 *
 * @param existing - Settings returned by the API, or nothing for a new gateway.
 * @returns The complete settings to send.
 */
export function desiredGateway(existing?: Record<string, unknown>): GatewaySettings {
  const current = carryOver(existing);
  const guardrails = (current.guardrails ?? {}) as Partial<GatewaySettings["guardrails"]>;
  const { P1: _removed, ...prompt } = guardrails.prompt ?? {};
  return {
    ...BASE_SETTINGS,
    ...current,
    collect_logs: true,
    guardrails: { prompt, response: { ...guardrails.response } },
  };
}

/**
 * The screening gateway. It sees only a visitor's question, never the system prompt, and blocks
 * on prompt injection (P1), so a blocked call is the signal. Nothing it passes is used, so other
 * categories and response checks are left off.
 *
 * @param existing - Settings returned by the API, or nothing for a new gateway.
 */
export function desiredScreenGateway(existing?: Record<string, unknown>): GatewaySettings {
  return {
    ...BASE_SETTINGS,
    ...carryOver(existing),
    collect_logs: true,
    guardrails: { prompt: { P1: "BLOCK" }, response: {} },
  };
}

/** Normalized Cloudflare API response. */
interface ApiResult {
  status: number;
  ok: boolean;
  body: { success?: boolean; result?: Record<string, unknown>; errors?: { message?: string }[] };
}

/** Outcome for each gateway. */
export interface GatewayOutcome {
  main: "created" | "updated";
  screen: "created" | "updated";
}

/**
 * Creates or updates both gateways. The token is only placed in the request
 * header, and error messages contain only what the Cloudflare API returns.
 *
 * @param rawEnvironment - Usually `process.env`; validated before any request.
 * @param fetcher - Replaceable for tests.
 * @returns Whether each gateway was created or updated.
 * @throws Error for invalid configuration or a failed API call.
 */
export async function applyGateway(rawEnvironment: unknown, fetcher: typeof fetch = fetch): Promise<GatewayOutcome> {
  const parsed = gatewayEnvironmentSchema.safeParse(rawEnvironment);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "The environment is not valid.");
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token, AI_GATEWAY_ID: mainId, SCREEN_GATEWAY_ID: screenId } = parsed.data;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`;

  const request = async (path: string, init: RequestInit = {}): Promise<ApiResult> => {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    // A non-JSON error body still produces a useful status-based failure.
    const body = (await response.json().catch(() => ({}))) as ApiResult["body"];
    return { status: response.status, ok: response.ok && body.success !== false, body };
  };
  const requireSuccess = (result: ApiResult, action: string) => {
    if (result.ok) return;
    const detail = result.body.errors?.map((error) => error.message).filter(Boolean).join("; ") || "no details returned";
    throw new Error(`Could not ${action} (HTTP ${result.status}): ${detail}`);
  };

  // Reading first lets the update preserve settings made outside this script.
  const upsert = async (gatewayId: string, desired: (existing?: Record<string, unknown>) => GatewaySettings) => {
    const existing = await request(`/${gatewayId}`);
    if (existing.status === 404) {
      const body = JSON.stringify({ id: gatewayId, ...desired() });
      requireSuccess(await request("", { method: "POST", body }), `create the gateway "${gatewayId}"`);
      return "created" as const;
    }
    requireSuccess(existing, `read the gateway "${gatewayId}"`);
    const body = JSON.stringify(desired(existing.body.result));
    requireSuccess(await request(`/${gatewayId}`, { method: "PUT", body }), `update the gateway "${gatewayId}"`);
    return "updated" as const;
  };
  return { main: await upsert(mainId, desiredGateway), screen: await upsert(screenId, desiredScreenGateway) };
}
