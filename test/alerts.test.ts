import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShowcaseAgent } from "../src/agent";
import { reportBudgetRefusal } from "../src/alerts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("budget alerts", () => {
  it("sends nothing without a project key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reportBudgetRefusal({}, "site-daily", 500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the limit and count only, and never throws", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await reportBudgetRefusal({ POSTHOG_PROJECT_KEY: "phc_test" }, "visitor-daily", 200);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(init?.body)) as { api_key: string; event: string; properties: Record<string, unknown> };
    expect(body).toMatchObject({ api_key: "phc_test", event: "ask_budget_refused", properties: { limit: "visitor-daily", used: 200, $process_person_profile: false } });
    expect(Object.keys(body.properties).sort()).toEqual(["$lib", "$process_person_profile", "limit", "used"]);

    fetchSpy.mockRejectedValue(new Error("network down"));
    await expect(reportBudgetRefusal({ POSTHOG_PROJECT_KEY: "phc_test" }, "per-minute")).resolves.toBeUndefined();
  });

  it("is sent when the shared daily budget refuses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const namespace = env.ShowcaseAgent as unknown as DurableObjectNamespace<ShowcaseAgent>;
    const agent = await getAgentByName<Env, ShowcaseAgent>(namespace, crypto.randomUUID().replaceAll("-", ""));
    await runInDurableObject(agent, (instance) => {
      (instance as unknown as { env: Env }).env = { ...instance["env"], POSTHOG_PROJECT_KEY: "phc_test" } as Env;
      expect(instance.consumeDailyBudget(0, 1)).toBe(false);
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain('"limit":"site-daily"');
  });
});
