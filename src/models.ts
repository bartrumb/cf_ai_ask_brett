/*
 * Single list of model IDs. Primary and secondary roles are applied in `llm.ts` and `speech.ts`.
 */
/**
 * Every model the app calls. Each one is routed through AI Gateway, except `tts.direct`, which is
 * Deepgram's own API and runs only when the `DEEPGRAM_API_KEY` Worker secret is set.
 */
export const MODELS = {
  llm: {
    primary: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    secondary: "@cf/thinkingmachines/inkling-2-small",
  },
  stt: {
    primary: "@cf/deepgram/nova-3",
    secondary: "@cf/openai/whisper-large-v3-turbo",
  },
  tts: {
    direct: "aura-2-aries-en",
    primary: "@cf/deepgram/aura-2-en",
    secondary: "@cf/deepgram/aura-1",
  },
} as const;

/**
 * Voices for the Workers AI speech models. Aries is the Aura-2 voice of the "Brett" podcast host.
 * Aura-1 has no Aries, so its fallback is the closest male voice.
 */
export const TTS_SPEAKERS = {
  primary: "aries",
  secondary: "orion",
} as const;
