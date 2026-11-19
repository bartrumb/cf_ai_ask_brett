/*
 * Runs the eval set and writes a report.
 *
 *   npm run eval:guards          Scores the topic guards locally. No network, no cost.
 *   npm run eval                 Asks the deployed agent every question over its real WebSocket.
 *   npm run eval -- --host localhost:8787 --repeat 3 --only facts,unknown
 *
 * The live run goes through the same path as a visitor: the Worker's checks, the guards, the model,
 * and output redaction. Each case gets a new conversation, so no case sees another's history. Model
 * questions count against the deployment's daily budget for one visitor network (200 units by
 * default), so one machine can run about two full passes a day. The run stops if a budget refuses.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AgentClient } from "agents/client";
import { classifyQuestion } from "../src/domain/guards";
import type { ActionResult, Snapshot } from "../src/domain/types";
import { KNOWLEDGE_SECTIONS, PROFILE } from "../src/generated/knowledge";
import { CASES, type Area, type EvalCase } from "./cases";
import { scoreCase, scoreGuardDecision, type Observation, type Score } from "./checks";

/** Longest wait for one answer. */
const ANSWER_TIMEOUT_MS = 90_000;
/** How often a pending answer is checked. Well under the agent's read budget. */
const POLL_MS = 400;
/** Pause between cases, which keeps the run under the per-address connection limit. */
const CASE_GAP_MS = 2_500;

interface Result {
  id: string;
  area: Area;
  run: number;
  question: string;
  source: Observation["source"];
  answer: string;
  /** From sending the question to the stored answer. Absent offline. */
  totalMs?: number;
  /** From sending the question to the first streamed text. Absent for fixed replies. */
  firstTextMs?: number;
  knownIssue?: string;
  score: Score;
}

const facts = [...KNOWLEDGE_SECTIONS.map(({ title, body }) => `${title}\n${body}`), JSON.stringify(PROFILE)].join("\n");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const newConversation = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Scores a case from the guard decision alone, the same decision the agent makes first. */
function observeOffline(item: EvalCase): Observation {
  return { answer: "", source: classifyQuestion(item.question) ? "guarded" : "workers-ai" };
}

/** Asks one question in a fresh conversation and waits for the stored answer. */
async function observeLive(item: EvalCase, host: string): Promise<Observation & { totalMs?: number; firstTextMs?: number }> {
  const local = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host);
  const client = new AgentClient({ agent: "ShowcaseAgent", name: newConversation(), host, protocol: local ? "ws" : "wss" });
  let firstTextAt: number | undefined;
  client.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (firstTextAt === undefined && typeof data === "string" && data.includes('"answer-delta"')) firstTextAt = performance.now();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection timed out")), 15_000);
      client.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
    });
    const started = performance.now();
    const sent = (await client.call("ask", [{ question: item.question, requestId: crypto.randomUUID() }])) as ActionResult;
    if (!sent.ok) return { answer: sent.error, source: "error" };
    while (performance.now() - started < ANSWER_TIMEOUT_MS) {
      const snapshot = (await client.call("getSnapshot")) as unknown as Snapshot;
      const last = snapshot.messages.at(-1);
      if (last?.role === "assistant") {
        return {
          answer: last.text,
          source: last.source ?? "unavailable",
          totalMs: Math.round(performance.now() - started),
          ...(firstTextAt === undefined ? {} : { firstTextMs: Math.round(firstTextAt - started) }),
        };
      }
      await sleep(POLL_MS);
    }
    return { answer: "no answer before the timeout", source: "error" };
  } catch (error) {
    return { answer: error instanceof Error ? error.message : String(error), source: "error" };
  } finally {
    client.close();
  }
}

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const pct = (passed: number, total: number) => (total ? `${Math.round((100 * passed) / total)}%` : "n/a");
const seconds = (ms: number | undefined) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const oneLine = (text: string, max = 220) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Builds the Markdown report. */
function report(results: Result[], mode: string, target: string, startedAt: string): string {
  const areas: Area[] = ["guard", "over-blocking", "facts", "unknown", "injection"];
  const rows = areas
    .map((area) => {
      const inArea = results.filter((result) => result.area === area);
      const passed = inArea.filter((result) => result.score.passed).length;
      return inArea.length ? `| ${area} | ${passed} / ${inArea.length} | ${pct(passed, inArea.length)} |` : "";
    })
    .filter(Boolean);
  const passed = results.filter((result) => result.score.passed).length;
  const model = results.filter((result) => result.source === "workers-ai" && result.totalMs !== undefined);
  const firstText = model.flatMap((result) => (result.firstTextMs === undefined ? [] : [result.firstTextMs]));
  const totals = model.map((result) => result.totalMs as number);
  const failed = results.filter((result) => !result.score.passed);

  const lines = [
    `# Eval results (${mode})`,
    "",
    `Run ${startedAt} against ${target}. ${results.length} scored answers from ${CASES.length} cases.`,
    ...(mode === "live" ? [] : ["", "Only the guard decision is scored here. A non-guard case passes when it reaches the model; the live run scores the answer itself."]),
    "",
    "| Area | Passed | Rate |",
    "| --- | --- | --- |",
    ...rows,
    `| **all** | **${passed} / ${results.length}** | **${pct(passed, results.length)}** |`,
  ];
  if (model.length) {
    lines.push(
      "",
      `Model answers: ${model.length}. Time to first text p50 ${seconds(percentile(firstText, 50))}, p95 ${seconds(percentile(firstText, 95))}. ` +
        `Time to full answer p50 ${seconds(percentile(totals, 50))}, p95 ${seconds(percentile(totals, 95))}.`,
    );
  }
  lines.push("", "## Failures", "");
  if (failed.length === 0) lines.push("None.");
  for (const result of failed) {
    lines.push(`- **${result.id}** (${result.area}${result.run > 1 ? `, run ${result.run}` : ""}): ${result.score.failures.join("; ")}`);
    if (result.knownIssue) lines.push(`  - Known issue: ${result.knownIssue}`);
    lines.push(`  - Q: ${result.question}`);
    if (result.answer) lines.push(`  - A: ${oneLine(result.answer)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      offline: { type: "boolean", default: false },
      host: { type: "string", default: "brett.bartrum.family" },
      repeat: { type: "string", default: "1" },
      only: { type: "string" },
      out: { type: "string", default: "evals/results" },
    },
  });
  const only = values.only ? new Set(values.only.split(",")) : null;
  const cases = CASES.filter((item) => !only || only.has(item.area) || only.has(item.id));
  const repeat = values.offline ? 1 : Math.max(1, Number(values.repeat) || 1);
  const mode = values.offline ? "offline guards" : "live";
  const target = values.offline ? "the local topic guards" : `https://${values.host}`;
  const startedAt = new Date().toISOString();
  const results: Result[] = [];

  for (let run = 1; run <= repeat; run += 1) {
    for (const item of cases) {
      const seen = values.offline ? observeOffline(item) : await observeLive(item, values.host);
      // Once a budget refuses, every later case would fail the same way and the report would
      // describe the budget, not the agent. Stop without overwriting the last complete results.
      if (seen.source === "error" && /reached its limit/i.test(seen.answer)) {
        process.stderr.write(`\nStopped at ${item.id}, run ${run}: the deployment's AI budget is used up. Earlier results were left unchanged.\n`);
        process.exitCode = 2;
        return;
      }
      const final = values.offline ? scoreGuardDecision(item, seen) : scoreCase(item, seen, facts);
      results.push({ id: item.id, area: item.area, run, question: item.question, ...seen, ...(item.knownIssue ? { knownIssue: item.knownIssue } : {}), score: final });
      process.stdout.write(`${final.passed ? "pass" : "FAIL"}  ${item.area.padEnd(13)} ${item.id}${final.passed ? "" : `  ${final.failures.join("; ")}`}\n`);
      if (!values.offline) await sleep(CASE_GAP_MS);
    }
  }

  const name = values.offline ? "guards" : "live";
  mkdirSync(values.out, { recursive: true });
  const markdown = report(results, mode, target, startedAt);
  writeFileSync(join(values.out, `${name}.md`), markdown);
  writeFileSync(join(values.out, `${name}.json`), `${JSON.stringify({ mode, target, startedAt, results }, null, 2)}\n`);
  process.stdout.write(`\n${markdown}`);
}

await main();
