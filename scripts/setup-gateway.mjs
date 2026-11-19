// Creates or updates the AI Gateway used by Codex Guard.
// Prints the planned settings by default. Add --apply to change the account.
import { DEFAULT_GATEWAY_ID, desiredGateway } from "../src/domain/gateway-config.ts";

const apply = process.argv.includes("--apply");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const gatewayId = process.env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID;

if (!apply) {
  console.log(`Planned settings for new gateway "${gatewayId}":`);
  console.log(JSON.stringify(desiredGateway(), null, 2));
  console.log("Nothing was changed. Run with --apply to create or update it.");
  process.exit(0);
}

if (!accountId || !token) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first.");
  console.error("The token needs AI Gateway Read and AI Gateway Edit.");
  process.exit(1);
}

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`;

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok && body.success !== false, body };
}

function failIfNeeded(result, action) {
  if (result.ok) return;
  const detail = result.body.errors?.map((error) => error.message).join("; ") || "no details returned";
  console.error(`Could not ${action} (HTTP ${result.status}): ${detail}`);
  process.exit(1);
}

const existing = await request(`/${gatewayId}`);
if (existing.status === 404) {
  failIfNeeded(
    await request("", { method: "POST", body: JSON.stringify({ id: gatewayId, ...desiredGateway() }) }),
    "create the gateway",
  );
  console.log(`Created gateway "${gatewayId}".`);
} else {
  failIfNeeded(existing, "read the gateway");
  failIfNeeded(
    await request(`/${gatewayId}`, { method: "PUT", body: JSON.stringify(desiredGateway(existing.body.result)) }),
    "update the gateway",
  );
  console.log(`Updated gateway "${gatewayId}".`);
}

console.log("Guardrails flag prompt injection (P1). Log collection is on.");
console.log("Add a spend limit in the dashboard: AI > AI Gateway > Settings > Spend limits.");
