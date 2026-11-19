import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache, verifyAccessToken } from "../src/access";
import type { ShowcaseAgent } from "../src/agent";
import worker from "../src/index";
import { conversationId, until } from "./fixtures";

const config = { teamDomain: "sample-team", audience: "sample-audience" };
const access = { ACCESS_TEAM_DOMAIN: config.teamDomain, ACCESS_AUD: config.audience };
const namespace = env.ShowcaseAgent as unknown as DurableObjectNamespace<ShowcaseAgent>;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const connect = (overrides: Partial<Env>, headers: Record<string, string> = {}, id = conversationId()) =>
  worker.fetch(new Request(`https://site.example/agents/showcase-agent/${id}`, { headers: { Upgrade: "websocket", ...headers } }), { ...env, ...overrides } as Env);

async function setup() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const fetcher = vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "key-1" }] })) as unknown as typeof fetch;
  const sign = async (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const body = `${encode({ alg: "RS256", kid: "key-1", ...header })}.${encode({
      aud: [config.audience],
      iss: "https://sample-team.cloudflareaccess.com",
      exp: Date.now() / 1000 + 60,
      ...claims,
    })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body));
    return `${body}.${Buffer.from(signature).toString("base64url")}`;
  };
  return { fetcher, sign };
}

describe("Cloudflare Access", () => {
  afterEach(() => {
    resetAccessKeyCache();
    vi.restoreAllMocks();
  });

  it("accepts a valid token and caches signing keys", async () => {
    const { fetcher, sign } = await setup();
    expect(await verifyAccessToken(await sign({ email: "person@example.com" }), config, fetcher)).toMatchObject({ email: "person@example.com" });
    expect(await verifyAccessToken(await sign({ aud: config.audience }), config, fetcher)).toMatchObject({ email: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an expired token", { exp: 1 }, {}],
    ["a future token", { nbf: Date.now() / 1000 + 600 }, {}],
    ["the wrong audience", { aud: "other" }, {}],
    ["the wrong issuer", { iss: "https://other.cloudflareaccess.com" }, {}],
    ["an unknown key", {}, { kid: "other" }],
    ["an unsigned algorithm", {}, { alg: "none" }],
  ])("rejects %s", async (_name, claims, header) => {
    const { fetcher, sign } = await setup();
    expect(await verifyAccessToken(await sign(claims, header), config, fetcher)).toBeNull();
  });

  it("rejects tampering, malformed tokens, unsafe teams and key failures", async () => {
    const { fetcher, sign } = await setup();
    const [head, , signature] = (await sign()).split(".");
    expect(await verifyAccessToken(`${head}.${encode({ aud: config.audience })}.${signature}`, config, fetcher)).toBeNull();
    expect(await verifyAccessToken(null, config, fetcher)).toBeNull();
    expect(await verifyAccessToken("a.b", config, fetcher)).toBeNull();
    expect(await verifyAccessToken("a.b.c.d", config, fetcher)).toBeNull();
    expect(await verifyAccessToken(await sign(), { ...config, teamDomain: "evil.example/x" }, fetcher)).toBeNull();
    resetAccessKeyCache();
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyAccessToken(await sign(), config, failing)).toBeNull();
    const counted = vi.fn(failing);
    expect(await verifyAccessToken(await sign(), config, counted as unknown as typeof fetch)).toBeNull();
    expect(counted).not.toHaveBeenCalled();
  });

  it("fails closed for real model mode without Access or the public switch", async () => {
    expect((await connect({ AI_MODE: "workers-ai" })).status).toBe(503);
    expect((await connect({ AI_MODE: "workers-ai", ALLOW_UNAUTHENTICATED_AI: "true" })).status).toBe(101);
  });

  it("requires a valid token once Access is configured", async () => {
    expect((await connect(access)).status).toBe(401);
    const { fetcher, sign } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    expect((await connect(access, { "Cf-Access-Jwt-Assertion": await sign() })).status).toBe(101);
  });

  it("closes a connection when its token expires and ignores spoofed expiry", async () => {
    const { fetcher, sign } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    const token = await sign({ exp: Date.now() / 1000 + 1.5 });
    const socket = (await connect(access, { "Cf-Access-Jwt-Assertion": token, "x-ask-brett-access-expires": "9999999999" })).webSocket;
    if (!socket) throw new Error("Expected a WebSocket.");
    let closed = 0;
    socket.addEventListener("close", (event) => { closed = event.code; });
    socket.accept();
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    socket.send(JSON.stringify({ type: "rpc", id: "late", method: "getSnapshot", args: [] }));
    await until(() => closed === 4401);
  });

  it("closes an expired silent connection before later broadcasts", async () => {
    const id = conversationId();
    const { fetcher, sign } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
    const socket = (await connect(access, { "Cf-Access-Jwt-Assertion": await sign({ exp: Date.now() / 1000 + 1 }) }, id)).webSocket;
    if (!socket) throw new Error("Expected a WebSocket.");
    let closed = 0;
    socket.addEventListener("close", (event) => { closed = event.code; });
    socket.accept();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const agent = await getAgentByName<Env, ShowcaseAgent>(namespace, id);
    await runInDurableObject(agent, (instance) => instance.broadcast("{}"));
    await until(() => closed === 4401);
  });

  it("strips internal SDK and identity headers supplied by clients", async () => {
    const response = await connect({}, { "x-agents-lifecycle-props": "{bad", "x-cf-agents-subagent-url": "/sub/x/y", "x-ask-brett-client": "forged", "x-ask-brett-access-expires": "1" });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket.");
    const frames: string[] = [];
    socket.addEventListener("message", (event) => { frames.push(String(event.data)); });
    socket.accept();
    socket.send(JSON.stringify({ type: "rpc", id: "ok", method: "getSnapshot", args: [] }));
    await until(() => frames.some((frame) => frame.includes('"id":"ok"') && frame.includes('"success":true')));
    socket.close();
  });
});
