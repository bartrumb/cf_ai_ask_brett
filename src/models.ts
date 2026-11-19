/*
 * Single list of model IDs. Primary and secondary roles are applied in `llm.ts` and `speech.ts`.
 */
/** Every model the app calls. Each one is routed through AI Gateway. */
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
    primary: "@cf/deepgram/aura-2-en",
    secondary: "@cf/deepgram/aura-1",
  },
} as const;
