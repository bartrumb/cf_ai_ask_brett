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
    // Cloudflare lists this model for removal on 2026-11-20.
    secondary: "@cf/myshell-ai/melotts",
  },
} as const;
