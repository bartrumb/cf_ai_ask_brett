import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildSpokenReview, decodeWav, MAX_SPOKEN_CHARS, toSpokenText } from "../src/domain/audio";
import { applyGateway, desiredGateway } from "../src/domain/gateway-config";
import { MAX_AUDIO_BYTES, parseInput, transcribeSchema } from "../src/domain/schemas";
import { evaluateChange } from "../src/domain/rules";
import { gatewayMetadata, isGuardrailBlock } from "../src/gateway";
import { MODELS } from "../src/models";
import { synthesizeSpeech, transcribeAudio } from "../src/speech";
import { allStandards, FAKE_SECRET, OPEN_INGRESS, parsed, wavBase64 } from "./fixtures";

const context = { repository: "sample-repo", feature: "speech" } as const;

interface Call {
  model: string;
  input: Record<string, unknown>;
  options: { gateway?: { id?: string; metadata?: Record<string, unknown> } };
}

function fakeEnv(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const AI = {
    run: async (model: string, input: Record<string, unknown>, options: Call["options"]) => {
      const call = { model, input, options };
      calls.push(call);
      return handler(call);
    },
  } as unknown as Ai;
  return { calls, env: { AI, AI_MODE: "workers-ai", AI_GATEWAY_ID: "test-gateway" } };
}

const wav = new Uint8Array(Buffer.from(wavBase64(), "base64"));

describe("speech to text", () => {
  it("uses the primary model through the gateway", async () => {
    const { calls, env } = fakeEnv(() => ({ results: { channels: [{ alternatives: [{ transcript: "hello there" }] }] } }));
    const result = await transcribeAudio(env, wav, { ...context, feature: "transcription" });
    expect(result).toEqual({ text: "hello there", source: "workers-ai", model: MODELS.stt.primary });
    expect(calls[0]?.options.gateway?.id).toBe("test-gateway");
    expect(calls[0]?.options.gateway?.metadata?.feature).toBe("transcription");
  });

  it("falls back to the secondary model on the same gateway", async () => {
    const { calls, env } = fakeEnv(({ model }) => {
      if (model === MODELS.stt.primary) throw new Error("unavailable");
      return { text: "from fallback" };
    });
    const result = await transcribeAudio(env, wav, context);
    expect(result).toMatchObject({ text: "from fallback", model: MODELS.stt.secondary });
    expect(calls.map((call) => call.options.gateway?.id)).toEqual(["test-gateway", "test-gateway"]);
    expect(typeof calls[1]?.input.audio).toBe("string");
  });
});

describe("text to speech", () => {
  it("uses the primary model through the gateway", async () => {
    const { calls, env } = fakeEnv(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const result = await synthesizeSpeech(env, "Hello.", context);
    expect(result).toMatchObject({ audio: "AQID", mimeType: "audio/mpeg", model: MODELS.tts.primary });
    expect(calls[0]?.options.gateway?.id).toBe("test-gateway");
  });

  it("falls back to the secondary model with the same request", async () => {
    const { calls, env } = fakeEnv(({ model }) =>
      model === MODELS.tts.primary ? new Response("no", { status: 500 }) : new Response(new Uint8Array([1, 2, 3])),
    );
    expect(await synthesizeSpeech(env, "Hello.", context)).toMatchObject({ audio: "AQID", model: MODELS.tts.secondary });
    expect(calls.map((call) => call.model)).toEqual([MODELS.tts.primary, MODELS.tts.secondary]);
    expect(calls[1]?.input).toEqual(calls[0]?.input);
    expect(calls[1]?.options.gateway?.id).toBe("test-gateway");
  });

  it("reports an empty speech response as a failure", async () => {
    const { env } = fakeEnv(() => new Response(new Uint8Array()));
    await expect(synthesizeSpeech(env, "Hello.", context)).rejects.toThrow("empty");
  });
});

describe("audio input", () => {
  const accepted = (audio: unknown) => {
    const input = parseInput(transcribeSchema, { audio });
    return input.ok ? decodeWav(input.data.audio).ok : false;
  };

  it("accepts a WAV recording", () => {
    expect(accepted(wavBase64())).toBe(true);
  });

  it.each([
    ["non-text input", 12],
    ["empty input", ""],
    ["invalid base64", "not base64!"],
    ["a non-WAV file", Buffer.alloc(100).toString("base64")],
    ["an oversized recording", "A".repeat(Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 8)],
  ])("rejects %s", (_name, value) => {
    expect(accepted(value)).toBe(false);
  });

  it("rejects decoded audio over the byte limit", () => {
    const large = Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64");
    expect(decodeWav(large)).toMatchObject({ ok: false });
  });
});

describe("spoken text", () => {
  const result = evaluateChange(parsed(OPEN_INGRESS), { standards: allStandards(), exceptions: [] });

  it("takes the verdict from the rule result, not the commentary", () => {
    const spoken = buildSpokenReview(result, "### F1 · STD-SEC-02\nThe risk is low.");
    expect(spoken.startsWith("Rule engine result: high risk, with 1 open finding.")).toBe(true);
    expect(spoken).toContain("Finding F1, standard STD-SEC-02.");
  });

  it("removes code, redacts secrets and caps length", () => {
    const spoken = toSpokenText(`token = "${FAKE_SECRET}"\n\`\`\`\ncode\n\`\`\`\n${"Sentence one. ".repeat(300)}`);
    expect(spoken).not.toContain(FAKE_SECRET);
    expect(spoken).not.toContain("```");
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
  });
});

describe("gateway configuration", () => {
  it("keeps metadata within the gateway's five-entry limit", () => {
    expect(Object.keys(gatewayMetadata({ repository: "r", feature: "review", reviewId: "1" }))).toHaveLength(5);
  });

  it("flags prompt injection and keeps logs on for a new gateway", () => {
    expect(desiredGateway()).toMatchObject({ collect_logs: true, guardrails: { prompt: { P1: "FLAG" } } });
  });

  it("preserves existing settings and removes read-only fields", () => {
    const settings = desiredGateway({
      id: "existing",
      created_at: "now",
      cache_ttl: 30,
      collect_logs: false,
      guardrails: { prompt: { P1: "BLOCK", S9: "FLAG" }, response: { S9: "BLOCK" } },
    });
    expect(settings).not.toHaveProperty("id");
    expect(settings).not.toHaveProperty("created_at");
    expect(settings).toMatchObject({
      cache_ttl: 30,
      collect_logs: true,
      guardrails: { prompt: { P1: "BLOCK", S9: "FLAG" }, response: { S9: "BLOCK" } },
    });
  });

  describe("setup", () => {
    const environment = {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "test_token_value_123456",
    };
    const reply = (status: number, body: unknown) => Response.json(body, { status });

    it("creates a missing gateway without exposing the token in the URL or body", async () => {
      const requests: { url: string; init?: RequestInit }[] = [];
      const fetcher = (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return requests.length === 1 ? reply(404, { success: false }) : reply(200, { success: true });
      }) as unknown as typeof fetch;
      await expect(applyGateway(environment, fetcher)).resolves.toBe("created");
      expect(requests[1]?.init?.method).toBe("POST");
      expect(JSON.stringify(requests.map(({ url, init }) => [url, init?.body]))).not.toContain(environment.CLOUDFLARE_API_TOKEN);
    });

    it("updates an existing gateway and keeps its settings", async () => {
      const bodies: string[] = [];
      const fetcher = (async (_url: string, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        return reply(200, { success: true, result: { id: "codex-guard", cache_ttl: 9 } });
      }) as unknown as typeof fetch;
      await expect(applyGateway(environment, fetcher)).resolves.toBe("updated");
      expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ cache_ttl: 9, guardrails: { prompt: { P1: "FLAG" } } });
    });

    it("reports API failures", async () => {
      const fetcher = (async () => reply(403, { success: false, errors: [{ message: "Denied" }] })) as unknown as typeof fetch;
      await expect(applyGateway(environment, fetcher)).rejects.toThrow("Denied");
    });

    it.each([
      [{ ...environment, CLOUDFLARE_ACCOUNT_ID: "../../other" }],
      [{ ...environment, CLOUDFLARE_API_TOKEN: "short" }],
      [{ ...environment, AI_GATEWAY_ID: "../bad" }],
      [{}],
    ])("rejects unsafe settings before any request", async (value) => {
      const fetcher = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
      await expect(applyGateway(value, fetcher)).rejects.not.toThrow("must not be called");
    });
  });

  it("recognizes Guardrails block errors", () => {
    expect(isGuardrailBlock(new Error("2016: Prompt blocked due to security configurations"))).toBe(true);
    expect(isGuardrailBlock(new Error("Model unavailable"))).toBe(false);
  });
});
