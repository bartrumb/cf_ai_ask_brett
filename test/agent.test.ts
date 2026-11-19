import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { CodexGuardAgent } from "../src/agent";
import type { ReviewRecord } from "../src/domain/types";
import worker from "../src/index";
import { diffFor, FAKE_SECRET, INJECTION_LINE, OPEN_INGRESS } from "./fixtures";

const namespace = env.CodexGuardAgent as unknown as DurableObjectNamespace<CodexGuardAgent>;
const newAgent = () => getAgentByName<Env, CodexGuardAgent>(namespace, `test-repo-${crypto.randomUUID().slice(0, 8)}`);
type Guard = Awaited<ReturnType<typeof newAgent>>;

async function reviewToCompletion(agent: Guard, text: string): Promise<ReviewRecord> {
  const started = await agent.startReview(text);
  if (!started.ok) throw new Error(started.error);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await agent.getSnapshot();
    const review = snapshot.reviews.find((item) => item.id === started.reviewId);
    if (review && review.status !== "running") return review as ReviewRecord;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Review did not finish.");
}

describe("review workflow", () => {
  it("stores rule results and separately labeled commentary", async () => {
    const agent = await newAgent();
    const review = await reviewToCompletion(agent, OPEN_INGRESS);
    expect(review.status).toBe("complete");
    expect(review.result?.risk).toBe("high");
    expect(review.commentarySource).toBe("offline");
    expect(review.commentary).toContain("STD-SEC-02");
    expect(review.commentaryWarnings).toEqual([]);
  });

  it("keeps the rule result when a diff tries to override it", async () => {
    const agent = await newAgent();
    const review = await reviewToCompletion(agent, diffFor("infra/n.tf", [INJECTION_LINE, 'cidr = "0.0.0.0/0"']));
    expect(review.result?.risk).toBe("high");
    expect(review.result?.findings.map((finding) => finding.standardId)).toEqual(["STD-SEC-02", "STD-AGT-01"]);
  });

  it("does not store a submitted secret anywhere the client can read", async () => {
    const agent = await newAgent();
    await reviewToCompletion(agent, diffFor("config/app.yml", [`api_key: "${FAKE_SECRET}"`]));
    expect(JSON.stringify(await agent.getSnapshot())).not.toContain(FAKE_SECRET);
    const pending = await runInDurableObject(agent, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_inputs").one().count,
    );
    expect(pending).toBe(0);
  });

  it.each([
    ["non-text input", 123],
    ["empty input", "   "],
    ["a malformed diff", "--- a/a\n+++ b/a\n@@ -1,1 +1,4 @@\n+cut off"],
    ["oversized input", "x".repeat(40_001)],
  ])("rejects %s before any review starts", async (_name, value) => {
    const agent = await newAgent();
    expect((await agent.startReview(value)).ok).toBe(false);
    expect((await agent.getSnapshot()).reviews).toEqual([]);
  });
});

describe("exception memory", () => {
  it("remembers an accepted exception in later reviews and can revoke it", async () => {
    const agent = await newAgent();
    const first = await reviewToCompletion(agent, OPEN_INGRESS);
    expect(first.result?.risk).toBe("high");

    const accepted = await agent.acceptException(first.id, "F1", "Partner access approved until the migration ends.");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const second = await reviewToCompletion(agent, OPEN_INGRESS);
    expect(second.result).toMatchObject({ risk: "low", riskBeforeExceptions: "high" });
    expect(second.result?.findings[0]?.status).toBe("excepted");

    expect((await agent.revokeException(accepted.exception.id)).ok).toBe(true);
    expect((await reviewToCompletion(agent, OPEN_INGRESS)).result?.risk).toBe("high");
  });

  it("keeps memory separate for each repository", async () => {
    const [one, two] = [await newAgent(), await newAgent()];
    const review = await reviewToCompletion(one, OPEN_INGRESS);
    await one.acceptException(review.id, "F1", "Approved for this repository only.");
    expect((await reviewToCompletion(two, OPEN_INGRESS)).result?.risk).toBe("high");
  });

  it("refuses mandatory standards, unknown findings and weak reasons", async () => {
    const agent = await newAgent();
    const review = await reviewToCompletion(agent, diffFor("docs/a.md", [INJECTION_LINE]));
    const reason = "A sufficiently long reason.";
    expect(await agent.acceptException(review.id, "F1", reason)).toMatchObject({ ok: false });
    expect(await agent.acceptException(review.id, "F99", reason)).toMatchObject({ ok: false });
    expect(await agent.acceptException("missing", "F1", reason)).toMatchObject({ ok: false });
    const open = await reviewToCompletion(agent, OPEN_INGRESS);
    expect(await agent.acceptException(open.id, "F1", "short")).toMatchObject({ ok: false });
    expect((await agent.getSnapshot()).exceptions).toEqual([]);
  });

  it("does not allow a mandatory standard to be turned off", async () => {
    const agent = await newAgent();
    expect((await agent.setStandardEnabled("STD-SEC-01", false)).ok).toBe(false);
    expect((await agent.setStandardEnabled("STD-OBS-01", false)).ok).toBe(true);
    const standards = (await agent.getSnapshot()).standards;
    expect(standards.find((s) => s.id === "STD-SEC-01")?.enabled).toBe(true);
    expect(standards.find((s) => s.id === "STD-OBS-01")?.enabled).toBe(false);
  });
});

describe("worker routing", () => {
  const upgrade = { Upgrade: "websocket" };
  const fetchWorker = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://guard.example${path}`, { headers }), env);

  it("rejects invalid repository names", async () => {
    expect((await fetchWorker("/agents/codex-guard-agent/Bad%20Name", upgrade)).status).toBe(400);
  });

  it("requires a WebSocket", async () => {
    expect((await fetchWorker("/agents/codex-guard-agent/repo")).status).toBe(426);
  });

  it("rejects connections from another site", async () => {
    const response = await fetchWorker("/agents/codex-guard-agent/repo", { ...upgrade, Origin: "https://other.example" });
    expect(response.status).toBe(403);
  });
});
