/*
 * Worker entry point. It guards WebSocket access to the agent and exports the Durable Object class.
 * Static assets are served by the platform; only `/agents/*` reaches this code.
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { BUDGET_INSTANCE, type ShowcaseAgent } from "./agent";
import { reportBudgetRefusal } from "./alerts";
import { DICTATION_PATH, openDictation } from "./dictation";
import { ACCESS_EXPIRES_HEADER, BUDGET_EXEMPT_HEADER, CLIENT_KEY_HEADER, verifyAccessToken, type AccessIdentity } from "./access";
import { conversationIdSchema } from "./domain/schemas";
import { isOffline } from "./llm";

export { ShowcaseAgent } from "./agent";

/** URL prefix for the one agent class. The remaining path is the conversation ID. */
const AGENT_PREFIX = "/agents/showcase-agent/";

/**
 * Blocks cross-site WebSocket connections from browsers. Requests with no `Origin` are allowed
 * because browsers always send one on WebSocket upgrades. This is not authentication.
 *
 * @returns True when the origin is absent or has the same host as the request.
 */
function hasAllowedOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

/**
 * Applies the access policy. A configured Access application is always enforced. Without one, only
 * offline mode or the deliberate public deployment may connect, so a misconfigured deployment that
 * can spend money fails closed.
 */
async function authorize(request: Request, env: Env): Promise<{ denied: Response } | { identity: AccessIdentity | null }> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    const identity = await verifyAccessToken(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
    return identity ? { identity } : { denied: new Response("Unauthorized", { status: 401 }) };
  }
  if (isOffline(env) || env.ALLOW_UNAUTHENTICATED_AI === "true") return { identity: null };
  return { denied: new Response("Cloudflare Access is not configured", { status: 503 }) };
}

/**
 * Groups an address for limits. IPv4 addresses stand alone. IPv6 addresses are expanded, including
 * `::`, and reduced to their /64, so one network cannot pose as many visitors.
 */
export function networkKey(address: string): string {
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.toLowerCase().split("::", 2);
  const groups = (part: string) => (part ? part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group])) : []);
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${all.slice(0, 4).map((group) => (Number.parseInt(group, 16) || 0).toString(16)).join(":")}::/64`;
}

/**
 * True when the address is on the owner's testing list: the optional `BUDGET_EXEMPT_IPS` secret,
 * a comma-separated list of addresses. Entries compare by network, so one IPv6 entry covers its /64.
 * The list is a secret so the owner's address never appears in the repository.
 */
export function isBudgetExempt(address: string | null, list: string | undefined): boolean {
  if (!address || !list) return false;
  const network = networkKey(address);
  return list.split(",").map((entry) => entry.trim()).some((entry) => entry !== "" && networkKey(entry) === network);
}

/** Creates a non-reversible daily visitor key for spend limits. IPv6 clients are grouped by /64. */
async function clientKey(request: Request): Promise<string> {
  const network = networkKey(request.headers.get("CF-Connecting-IP") ?? "local");
  const value = `${new Date().toISOString().slice(0, 10)}:${network}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuilds the request for the agent. Client values for internal headers and the SDK's internal
 * headers are removed, so only the Worker can supply identity to the Durable Object.
 */
async function forwardRequest(request: Request, identity: AccessIdentity | null, exempt: boolean): Promise<Request> {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-ask-brett-") || /^x-(?:cf-)?agents-/.test(name)) headers.delete(name);
  }
  headers.set(CLIENT_KEY_HEADER, await clientKey(request));
  if (identity) headers.set(ACCESS_EXPIRES_HEADER, String(identity.expiresAt));
  if (exempt) headers.set(BUDGET_EXEMPT_HEADER, "1");
  return new Request(request, { headers });
}

/**
 * Opens a live dictation socket after the same checks as a conversation. One session costs one
 * budget unit, like one recorded transcription, and the owner's testing network skips the daily
 * budgets as it does in the agent. Offline mode has no transcriber, so the browser falls back.
 */
async function dictation(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  // HTTP/2 can drop the Upgrade header on the way in; every WebSocket handshake carries a version.
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" && !request.headers.get("Sec-WebSocket-Version")) {
    return new Response("WebSocket required", { status: 426 });
  }
  if (!hasAllowedOrigin(request, url)) return new Response("Forbidden", { status: 403 });
  const address = request.headers.get("CF-Connecting-IP");
  if (!(await env.CONNECT_LIMIT.limit({ key: networkKey(address ?? "local") })).success) {
    return new Response("Too many connections", { status: 429 });
  }
  const access = await authorize(request, env);
  if ("denied" in access) return access.denied;
  if (isOffline(env)) return new Response("Dictation is unavailable offline", { status: 503 });
  if (!(await env.AI_ACTION_LIMIT.limit({ key: "global" })).success) {
    // Daily refusals are reported by the budget instance itself; this one happens here.
    console.warn("budget refused", { limit: "per-minute" });
    ctx?.waitUntil(reportBudgetRefusal(env as Env & { POSTHOG_PROJECT_KEY?: string }, "per-minute"));
    return new Response("Busy", { status: 429 });
  }
  if (!isBudgetExempt(address, (env as Env & { BUDGET_EXEMPT_IPS?: string }).BUDGET_EXEMPT_IPS)) {
    const limit = Number(env.DAILY_AI_ACTION_LIMIT);
    const clientLimit = Number(env.DAILY_CLIENT_AI_ACTION_LIMIT);
    let allowed = false;
    try {
      const namespace = env.ShowcaseAgent as unknown as DurableObjectNamespace<ShowcaseAgent>;
      const budget = await getAgentByName<Env, ShowcaseAgent>(namespace, BUDGET_INSTANCE);
      allowed = limit > 0 && clientLimit > 0 && (await budget.consumeDailyBudget(limit, 1, await clientKey(request), clientLimit));
    } catch (error) {
      console.error("dictation budget check failed", error instanceof Error ? error.message : "unknown error");
    }
    if (!allowed) return new Response("Busy", { status: 429 });
  }
  return openDictation(env);
}

/**
 * Validates agent connections before routing them. Cheap checks come first, so rejected requests
 * do not use the per-address connection budget.
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/agents/")) return new Response("Not found", { status: 404 });
    if (url.pathname === DICTATION_PATH) return dictation(request, env, url, ctx);

    const conversation = url.pathname.startsWith(AGENT_PREFIX) ? url.pathname.slice(AGENT_PREFIX.length) : "";
    if (!conversationIdSchema.safeParse(conversation).success) {
      return new Response("Invalid conversation", { status: 400 });
    }
    // Parameters starting with "__" select SDK internals, such as a socket that stays in memory.
    if ([...url.searchParams.keys()].some((name) => name.startsWith("__"))) {
      return new Response("Unsupported parameter", { status: 400 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    if (!hasAllowedOrigin(request, url)) return new Response("Forbidden", { status: 403 });

    // The header is absent in local development, where all connections share one key.
    const client = networkKey(request.headers.get("CF-Connecting-IP") ?? "local");
    const { success } = await env.CONNECT_LIMIT.limit({ key: client });
    if (!success) return new Response("Too many connections", { status: 429 });

    const access = await authorize(request, env);
    if ("denied" in access) return access.denied;

    const exempt = isBudgetExempt(request.headers.get("CF-Connecting-IP"), (env as Env & { BUDGET_EXEMPT_IPS?: string }).BUDGET_EXEMPT_IPS);
    return (await routeAgentRequest(await forwardRequest(request, access.identity, exempt), env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
