// Creates or updates the AI Gateway used by Codex Guard.
// Prints the planned settings by default. Add --apply to change the account.
import { applyGateway, DEFAULT_GATEWAY_ID, desiredGateway } from "../src/domain/gateway-config.ts";

if (!process.argv.includes("--apply")) {
  console.log(`Planned settings for new gateway "${process.env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID}":`);
  console.log(JSON.stringify(desiredGateway(), null, 2));
  console.log("Nothing was changed. Run with --apply to create or update it.");
  process.exit(0);
}

try {
  const outcome = await applyGateway(process.env);
  console.log(`Gateway ${outcome}. Guardrails flag prompt injection (P1), and log collection is on.`);
  console.log("Add a spend limit in the dashboard: AI > AI Gateway > Settings > Spend limits.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "The gateway could not be configured.");
  process.exitCode = 1;
}
