/*
 * Worker entry point. It guards WebSocket access to the agent and exports the Durable Object class.
 * Static assets are served by the platform; only `/agents/*` reaches this code.
 */
import { routeAgentRequest } from "agents";
import { ACCESS_EXPIRES_HEADER, CLIENT_KEY_HEADER, verifyAccessToken, type AccessIdentity } from "./access";
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

/** Creates a non-reversible daily visitor key for spend limits. IPv6 clients are grouped by /64. */
async function clientKey(request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "local";
  const network = address.includes(":") ? address.split(":").slice(0, 4).join(":") : address;
  const value = `${new Date().toISOString().slice(0, 10)}:${network}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rebuilds the request for the agent. Client values for internal headers and the SDK's internal
 * headers are removed, so only the Worker can supply identity to the Durable Object.
 */
async function forwardRequest(request: Request, identity: AccessIdentity | null): Promise<Request> {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-ask-brett-") || /^x-(?:cf-)?agents-/.test(name)) headers.delete(name);
  }
  headers.set(CLIENT_KEY_HEADER, await clientKey(request));
  if (identity) headers.set(ACCESS_EXPIRES_HEADER, String(identity.expiresAt));
  return new Request(request, { headers });
}

/**
 * Validates agent connections before routing them. Cheap checks come first, so rejected requests
 * do not use the per-address connection budget.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/agents/")) return new Response("Not found", { status: 404 });

    const conversation = url.pathname.startsWith(AGENT_PREFIX) ? url.pathname.slice(AGENT_PREFIX.length) : "";
    if (!conversationIdSchema.safeParse(conversation).success) {
      return new Response("Invalid conversation", { status: 400 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    if (!hasAllowedOrigin(request, url)) return new Response("Forbidden", { status: 403 });

    // The header is absent in local development, where all connections share one key.
    const client = request.headers.get("CF-Connecting-IP") ?? "local";
    const { success } = await env.CONNECT_LIMIT.limit({ key: client });
    if (!success) return new Response("Too many connections", { status: 429 });

    const access = await authorize(request, env);
    if ("denied" in access) return access.denied;

    return (await routeAgentRequest(await forwardRequest(request, access.identity), env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
