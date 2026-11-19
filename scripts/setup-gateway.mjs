// Creates or updates the two AI Gateways used by Ask about Brett: the main gateway for every model
// call, and the screening gateway that checks a visitor's own words for prompt injection.
// Prints the planned settings by default. Add --apply to change the account.
// Node runs the TypeScript import directly through type stripping, so no build step is needed.
// The plan path needs no credentials. With --apply, CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN are required, and any failure sets a non-zero exit code.
import { applyGateway, DEFAULT_GATEWAY_ID, DEFAULT_SCREEN_GATEWAY_ID, desiredGateway, desiredScreenGateway } from "../src/domain/gateway-config.ts";

if (!process.argv.includes("--apply")) {
  // The plan shows defaults for new gateways. It does not read any existing gateway.
  console.log(`Planned settings for new gateway "${process.env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID}":`);
  console.log(JSON.stringify(desiredGateway(), null, 2));
  console.log(`Planned settings for new screening gateway "${process.env.SCREEN_GATEWAY_ID ?? DEFAULT_SCREEN_GATEWAY_ID}":`);
  console.log(JSON.stringify(desiredScreenGateway(), null, 2));
  console.log("Nothing was changed. Run with --apply to create or update them.");
  process.exit(0);
}

try {
  const outcome = await applyGateway(process.env);
  console.log(`Main gateway ${outcome.main}, screening gateway ${outcome.screen}. Log collection is on for both.`);
  console.log("The screening gateway blocks prompt injection (P1); the main gateway has no P1 check.");
  console.log("Add a spend limit in the dashboard: AI > AI Gateway > Settings > Spend limits.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "The gateways could not be configured.");
  process.exitCode = 1;
}
