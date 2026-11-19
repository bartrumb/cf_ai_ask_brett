/*
 * Worker entry point. It guards WebSocket access to the agent and exports the classes that
 * Wrangler binds. Static assets are served by the platform; only `/agents/*` reaches this code.
 */
import { routeAgentRequest } from "agents";
import { verifyAccessToken } from "./access";
import { repositoryNameSchema } from "./domain/schemas";
import { isOffline } from "./llm";

export { CodexGuardAgent } from "./agent";
export { ReviewWorkflow } from "./workflow";

/** URL prefix for the one agent class. The remaining path is the repository name. */
const AGENT_PREFIX = "/agents/codex-guard-agent/";

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
 * offline mode or an explicit local override may connect, so a deployment that can spend money and
 * expose repository memory fails closed.
 */
async function authorize(request: Request, env: Env): Promise<Response | null> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    const valid = await verifyAccessToken(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
    return valid ? null : new Response("Unauthorized", { status: 401 });
  }
  if (isOffline(env) || env.ALLOW_UNAUTHENTICATED_AI === "true") return null;
  return new Response("Cloudflare Access is not configured", { status: 503 });
}

/**
 * Validates agent connections before routing them. Cheap checks come first, so rejected requests
 * do not use the per-address connection budget.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/agents/")) return new Response("Not found", { status: 404 });

    const repository = url.pathname.startsWith(AGENT_PREFIX) ? url.pathname.slice(AGENT_PREFIX.length) : "";
    if (!repositoryNameSchema.safeParse(repository).success) {
      return new Response("Invalid repository name", { status: 400 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    if (!hasAllowedOrigin(request, url)) return new Response("Forbidden", { status: 403 });
    const denied = await authorize(request, env);
    if (denied) return denied;

    // The header is absent in local development, where all connections share one key.
    const client = request.headers.get("CF-Connecting-IP") ?? "local";
    const { success } = await env.CONNECT_LIMIT.limit({ key: client });
    if (!success) return new Response("Too many connections", { status: 429 });

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
