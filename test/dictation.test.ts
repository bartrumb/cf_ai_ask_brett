import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DICTATION_PATH, openDictation } from "../src/dictation";
import worker from "../src/index";
import { until } from "./fixtures";

const live = { AI_MODE: "workers-ai", ALLOW_UNAUTHENTICATED_AI: "true" };
const request = (headers: Record<string, string> = {}) =>
  new Request(`https://site.example${DICTATION_PATH}`, { headers: { Upgrade: "websocket", ...headers } });

/** A fake Flux: the test holds one end, and AI.run hands the Worker the other. */
function fakeFlux() {
  const [workerSide, testSide] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  testSide.accept();
  testSide.binaryType = "arraybuffer";
  const received: (string | ArrayBuffer)[] = [];
  testSide.addEventListener("message", (event) => { received.push(event.data as string | ArrayBuffer); });
  const run = vi.fn(async () => new Response(null, { status: 101, webSocket: workerSide }));
  return { flux: testSide, received, ai: { run } as unknown as Ai, run };
}

describe("dictation route", () => {
  it("needs a WebSocket, the page's own origin and a live model", async () => {
    expect((await worker.fetch(new Request(`https://site.example${DICTATION_PATH}`), { ...env, ...live } as Env)).status).toBe(426);
    expect((await worker.fetch(request({ Origin: "https://evil.example" }), { ...env, ...live } as Env)).status).toBe(403);
    expect((await worker.fetch(request(), env)).status).toBe(503);
    expect((await worker.fetch(request(), { ...env, AI_MODE: "workers-ai" } as Env)).status).toBe(503);
  });

  it("refuses when a budget is used up, unless the network is the owner's", async () => {
    const { ai, run } = fakeFlux();
    const busy = { ...env, ...live, AI: ai, DAILY_AI_ACTION_LIMIT: "0" } as Env;
    expect((await worker.fetch(request({ "Sec-WebSocket-Version": "13" }), busy)).status).toBe(429);
    expect(run).not.toHaveBeenCalled();
    const owner = { ...busy, BUDGET_EXEMPT_IPS: "203.0.113.7" } as Env;
    expect((await worker.fetch(request({ "CF-Connecting-IP": "203.0.113.7" }), owner)).status).toBe(101);
    const perMinute = { ...owner, AI_ACTION_LIMIT: { limit: async () => ({ success: false }) } } as Env;
    expect((await worker.fetch(request({ "CF-Connecting-IP": "203.0.113.7" }), perMinute)).status).toBe(429);
  });

  it("charges one unit from the shared budget for a visitor", async () => {
    const { ai } = fakeFlux();
    const response = await worker.fetch(request({ "CF-Connecting-IP": "198.51.100.4" }), { ...env, ...live, AI: ai } as Env);
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});

describe("dictation relay", () => {
  it("passes audio to Flux, transcripts back, and turns a text frame into CloseStream", async () => {
    const { flux, received, ai, run } = fakeFlux();
    const response = await openDictation({ AI: ai });
    expect(run).toHaveBeenCalledWith("@cf/deepgram/flux", { encoding: "linear16", sample_rate: "16000" }, { websocket: true });
    const browser = response.webSocket;
    if (!browser) throw new Error("Expected a WebSocket.");
    browser.accept();
    const transcripts: string[] = [];
    browser.addEventListener("message", (event) => { transcripts.push(String(event.data)); });
    browser.send(new Uint8Array([1, 2, 3, 4]).buffer);
    browser.send("stop");
    flux.send(JSON.stringify({ event: "Update", transcript: "hello" }));
    flux.send(new Uint8Array([9]).buffer);
    await until(() => received.length >= 2 && transcripts.length >= 1);
    const audio = received.find((frame) => typeof frame !== "string");
    expect(audio && new Uint8Array(audio as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(received).toContain(JSON.stringify({ type: "CloseStream" }));
    expect(transcripts).toEqual([JSON.stringify({ event: "Update", transcript: "hello" })]);
  });

  it("closes the session on an oversized text frame or when Flux closes", async () => {
    const first = fakeFlux();
    const one = (await openDictation({ AI: first.ai })).webSocket;
    if (!one) throw new Error("Expected a WebSocket.");
    one.accept();
    let closed: number | undefined;
    one.addEventListener("close", (event) => { closed = event.code; });
    one.send("x".repeat(300));
    await until(() => closed);
    expect(closed).toBe(1009);

    const second = fakeFlux();
    const two = (await openDictation({ AI: second.ai })).webSocket;
    if (!two) throw new Error("Expected a WebSocket.");
    two.accept();
    let reason = "";
    two.addEventListener("close", (event) => { reason = event.reason; });
    second.flux.close(1000, "done");
    await until(() => reason);
    expect(reason).toBe("Transcriber closed");
  });

  it("answers 502 when Flux cannot be reached", async () => {
    const failing = { run: async () => { throw new Error("down"); } } as unknown as Ai;
    expect((await openDictation({ AI: failing })).status).toBe(502);
    const refused = { run: async () => new Response("no", { status: 400 }) } as unknown as Ai;
    expect((await openDictation({ AI: refused })).status).toBe(502);
  });
});
