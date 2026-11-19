/*
 * Single list of model IDs. Primary and secondary roles are applied in `llm.ts` and `speech.ts`.
 */
/**
 * Every model the app calls. Each one is routed through AI Gateway, except `tts.elevenLabs` and
 * `tts.deepgram`, which call those vendors' own APIs and run only when their Worker secrets are set.
 */
export const MODELS = {
  llm: {
    primary: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    secondary: "@cf/thinkingmachines/inkling-2-small",
  },
  stt: {
    /** Live dictation: audio streams in while the visitor speaks. Called over a binding WebSocket, outside AI Gateway. */
    streaming: "@cf/deepgram/flux",
    primary: "@cf/deepgram/nova-3",
    secondary: "@cf/openai/whisper-large-v3-turbo",
  },
  tts: {
    elevenLabs: "eleven_v4",
    deepgram: "aura-2-aries-en",
    primary: "@cf/deepgram/aura-2-en",
    secondary: "@cf/deepgram/aura-1",
  },
} as const;

/** Jarnathan, the ElevenLabs voice of the "Brett" podcast host, with the podcast's settings. */
export const ELEVENLABS_VOICE = {
  id: "c6SfcYrb2t09NHXiT80T",
  settings: { stability: 0.3, similarity_boost: 0.72 },
} as const;

/**
 * Voices for the Workers AI speech models. Aries is the Aura-2 voice of the "Brett" podcast host.
 * Aura-1 has no Aries, so its fallback is the closest male voice.
 */
export const TTS_SPEAKERS = {
  primary: "aries",
  secondary: "orion",
} as const;
