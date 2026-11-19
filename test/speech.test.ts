import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWav, MAX_SPOKEN_CHARS, toSpokenText } from "../src/domain/audio";
import { applyGateway, desiredGateway } from "../src/domain/gateway-config";
import { MAX_AUDIO_BYTES, parseInput, transcribeSchema } from "../src/domain/schemas";
import { gatewayMetadata } from "../src/gateway";
import { MODELS, TTS_SPEAKERS } from "../src/models";
import { synthesizeSpeech, transcribeAudio } from "../src/speech";
import { FAKE_SECRET, wavBase64 } from "./fixtures";

const context = { conversation: "sample-conversation", feature: "speech" } as const;

interface Call {
  model: string;
  input: Record<string, unknown>;
  options: { gateway?: { id?: string; metadata?: Record<string, unknown> } };
}

function fakeEnv(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const AI = {
    gateway: () => ({ getUrl: async () => "https://gateway.example/v1/account/test-gateway/workers-ai/" }),
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
  afterEach(() => vi.restoreAllMocks());

  it("uses Whisper through the gateway when Nova has no gateway token", async () => {
    const { calls, env } = fakeEnv(() => ({ text: " hello there " }));
    const result = await transcribeAudio(env, wav, { ...context, feature: "transcription" });
    expect(result).toEqual({ text: "hello there", source: "workers-ai", model: MODELS.stt.secondary });
    expect(calls.map((call) => call.model)).toEqual([MODELS.stt.secondary]);
    expect(calls[0]?.options.gateway?.id).toBe("test-gateway");
    expect(typeof calls[0]?.input.audio).toBe("string");
  });

  it("sends Nova audio to the gateway HTTP endpoint when a token is configured", async () => {
    const { calls, env } = fakeEnv(() => ({ text: "unused" }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: { results: { channels: [{ alternatives: [{ transcript: " from nova " }] }] } } }));
    const result = await transcribeAudio({ ...env, AI_GATEWAY_TOKEN: "test-token" }, wav, context);
    expect(result).toMatchObject({ text: "from nova", model: MODELS.stt.primary });
    expect(calls).toEqual([]);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://gateway.example/v1/account/test-gateway/workers-ai/${MODELS.stt.primary}?smart_format=true&punctuate=true`);
    expect(new Headers(init.headers).get("cf-aig-authorization")).toBe("Bearer test-token");
  });

  it("falls back to Whisper when the Nova request fails", async () => {
    const { env } = fakeEnv(() => ({ text: "from fallback" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 401 }));
    await expect(transcribeAudio({ ...env, AI_GATEWAY_TOKEN: "test-token" }, wav, context)).resolves.toMatchObject({ text: "from fallback", model: MODELS.stt.secondary });
  });
});

describe("text to speech", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the primary model and podcast voice through the gateway without a Deepgram key", async () => {
    const { calls, env } = fakeEnv(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const fetcher = vi.spyOn(globalThis, "fetch");
    const result = await synthesizeSpeech(env, "Hello.", context);
    expect(result).toMatchObject({ audio: "AQID", mimeType: "audio/mpeg", source: "workers-ai", model: MODELS.tts.primary });
    expect(calls[0]?.options.gateway?.id).toBe("test-gateway");
    expect(calls[0]?.input.speaker).toBe(TTS_SPEAKERS.primary);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("calls Deepgram directly with the podcast voice when a key is set", async () => {
    const { calls, env } = fakeEnv(() => new Response("unused"));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const result = await synthesizeSpeech({ ...env, DEEPGRAM_API_KEY: "test-key" }, "Hello.", context);
    expect(result).toEqual({ audio: "AQID", mimeType: "audio/mpeg", source: "deepgram", model: "aura-2-aries-en" });
    expect(calls).toEqual([]);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-aries-en&encoding=mp3");
    expect(url).not.toContain("test-key");
    expect(new Headers(init.headers).get("Authorization")).toBe("Token test-key");
    expect(init.body).toBe(JSON.stringify({ text: "Hello." }));
    expect(init.redirect).toBe("manual");
  });

  it.each([
    ["an error status", () => Promise.resolve(new Response("no", { status: 401 }))],
    ["a redirect", () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://example.com/" } }))],
    ["a network failure", () => Promise.reject(new Error("offline"))],
  ])("falls back to the gateway when Deepgram returns %s", async (_name, reply) => {
    const { calls, env } = fakeEnv(() => new Response(new Uint8Array([1, 2, 3])));
    vi.spyOn(globalThis, "fetch").mockImplementation(reply);
    const result = await synthesizeSpeech({ ...env, DEEPGRAM_API_KEY: "test-key" }, "Hello.", context);
    expect(result).toMatchObject({ audio: "AQID", source: "workers-ai", model: MODELS.tts.secondary });
    expect(calls.map((call) => call.model)).toEqual([MODELS.tts.secondary]);
  });

  it("prefers the ElevenLabs podcast voice over every other option", async () => {
    const { calls, env } = fakeEnv(() => new Response("unused"));
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const result = await synthesizeSpeech({ ...env, ELEVENLABS_API_KEY: "eleven-key", DEEPGRAM_API_KEY: "test-key" }, "Hello.", context);
    expect(result).toEqual({ audio: "AQID", mimeType: "audio/mpeg", source: "elevenlabs", model: "eleven_v4" });
    expect(calls).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/c6SfcYrb2t09NHXiT80T?output_format=mp3_44100_64");
    expect(url).not.toContain("eleven-key");
    expect(new Headers(init.headers).get("xi-api-key")).toBe("eleven-key");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Hello.",
      model_id: "eleven_v4",
      voice_settings: { stability: 0.3, similarity_boost: 0.72 },
    });
    expect(init.redirect).toBe("manual");
  });

  it("falls back from ElevenLabs to Deepgram when both keys are set", async () => {
    const { calls, env } = fakeEnv(() => new Response("unused"));
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("elevenlabs") ? new Response("no", { status: 429 }) : new Response(new Uint8Array([1, 2, 3])),
    );
    const result = await synthesizeSpeech({ ...env, ELEVENLABS_API_KEY: "eleven-key", DEEPGRAM_API_KEY: "test-key" }, "Hello.", context);
    expect(result).toMatchObject({ source: "deepgram", model: MODELS.tts.deepgram });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });

  it("falls back from ElevenLabs to Aura-1 without a Deepgram key", async () => {
    const { calls, env } = fakeEnv(() => new Response(new Uint8Array([1, 2, 3])));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 401 }));
    const result = await synthesizeSpeech({ ...env, ELEVENLABS_API_KEY: "eleven-key" }, "Hello.", context);
    expect(result).toMatchObject({ source: "workers-ai", model: MODELS.tts.secondary });
    expect(calls.map((call) => call.model)).toEqual([MODELS.tts.secondary]);
  });

  it("falls back when Deepgram stalls", async () => {
    const { env } = fakeEnv(() => new Response(new Uint8Array([1, 2, 3])));
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    await expect(synthesizeSpeech({ ...env, DEEPGRAM_API_KEY: "test-key" }, "Hello.", context, 5)).resolves.toMatchObject({ model: MODELS.tts.secondary });
  });

  it("falls back to the secondary model and its own voice", async () => {
    const { calls, env } = fakeEnv(({ model }) =>
      model === MODELS.tts.primary ? new Response("no", { status: 500 }) : new Response(new Uint8Array([1, 2, 3])),
    );
    expect(await synthesizeSpeech(env, "Hello.", context)).toMatchObject({ audio: "AQID", model: MODELS.tts.secondary });
    expect(calls.map((call) => call.model)).toEqual([MODELS.tts.primary, MODELS.tts.secondary]);
    expect(calls[1]?.input).toEqual({ ...calls[0]?.input, speaker: TTS_SPEAKERS.secondary });
    expect(calls[1]?.options.gateway?.id).toBe("test-gateway");
  });

  it("falls back when the primary model stalls", async () => {
    const { calls, env } = fakeEnv(({ model }) =>
      model === MODELS.tts.primary ? new Promise(() => {}) : new Response(new Uint8Array([1, 2, 3])),
    );
    await expect(synthesizeSpeech(env, "Hello.", context, 5)).resolves.toMatchObject({ audio: "AQID", model: MODELS.tts.secondary });
    expect(calls).toHaveLength(2);
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
  it("removes markup, masks private values and caps length", () => {
    const spoken = toSpokenText('**Result** `code` token = "' + FAKE_SECRET + '" saved $40K\n' + "Sentence one. ".repeat(300));
    expect(spoken).not.toContain(FAKE_SECRET);
    expect(spoken).not.toContain("$40K");
    expect(spoken).not.toMatch(/[*`]/);
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
  });
});

describe("gateway configuration", () => {
  it("labels requests for this app within the gateway's five-entry limit", () => {
    const metadata = gatewayMetadata({ conversation: "c", feature: "question" });
    expect(metadata.app).toBe("ask-brett");
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(5);
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
        return reply(200, { success: true, result: { id: "existing", cache_ttl: 9 } });
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

});
