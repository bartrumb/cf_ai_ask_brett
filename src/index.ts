import { routeAgentRequest } from "agents";

export { CodexGuardAgent } from "./agent";
export { ReviewWorkflow } from "./workflow";

const AGENT_PATH = /^\/agents\/codex-guard-agent\/([a-z0-9][a-z0-9._-]{0,63})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/agents/")) return new Response("Not found", { status: 404 });

    if (!AGENT_PATH.test(url.pathname)) return new Response("Invalid repository name", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 });

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
