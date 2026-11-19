import { routeAgentRequest } from "agents";
import { repositoryNameSchema } from "./domain/schemas";

export { CodexGuardAgent } from "./agent";
export { ReviewWorkflow } from "./workflow";

const AGENT_PREFIX = "/agents/codex-guard-agent/";

function hasAllowedOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

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

    const client = request.headers.get("CF-Connecting-IP") ?? "local";
    const { success } = await env.CONNECT_LIMIT.limit({ key: client });
    if (!success) return new Response("Too many connections", { status: 429 });

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
