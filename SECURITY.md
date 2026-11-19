# Security

Ask about Brett is a public site. Every question, transcript and model response is treated as untrusted.

## Controls

| Risk | Control |
| --- | --- |
| Private content in the repository | The real knowledge base, site content and generated files are gitignored. Only invented examples are committed |
| Private instructions reaching a model | The build removes the title block and instruction section, and fails if a removed line survives |
| Sensitive figures in answers | Money figures and phone numbers are withheld from model context and masked again in streamed, stored and spoken answers |
| Sensitive topics | Deterministic guards answer compensation, financial, private contact, personal, job-search, government and instruction-probing questions with fixed text and no model call. Patterns describe categories and reveal nothing about the profile |
| Prompt injection | Turns have no tools and one step. Profile facts stay in the system prompt, and visitor text, including earlier exchanges, stays in an unpredictable per-turn delimiter |
| Direct use of agent protocols | The socket accepts only `getSnapshot`, `ask`, `transcribe` and `speak`, each validated by zod. Chat, state, tool and other frames are dropped |
| Conversation access | Routes accept only 128-bit random IDs, so there is no shared or guessable conversation, and the budget instance cannot be routed to |
| Spoofed identity | The Worker strips internal and SDK headers. Visitor keys and Access expiry come only from the Worker. Clients cannot write agent state |
| Cross-site socket use | Browser connections must come from the same host |
| Cost abuse | Connection, per-connection, per-conversation, shared per-minute, daily global and daily per-visitor limits apply. Speech costs five units. Questions are capped at 500 characters and audio at 30 seconds |
| Duplicate spend | Request IDs are idempotent through Think's submission records |
| Secret exposure | One redactor covers stored questions, prompts, live text, answers and speech |
| Data retention | Think's transcript is cleared after each turn. Conversations are deleted after 30 idle days |
| Script injection | All dynamic text is added as text nodes under a strict Content Security Policy, with no external scripts or fonts |
| Optional private deployment | Cloudflare Access tokens are verified for signature, issuer, audience and time, and sockets close when a token expires |

## Remaining risks

- A model can still misstate facts. The page says answers are AI-generated and should be verified.
- Guards use patterns. An unusual phrasing can get past them and reach the model, which then has only sanitized facts. Harmless questions can occasionally get a fixed reply.
- The full sanitized knowledge base is sent to AI Gateway and Workers AI each turn, and gateway logs may contain it. Review it as content you are willing to send there, and set log retention to suit.
- Output masking covers money and phone formats only. Anything else in the knowledge base can appear in an answer, so remove it from the source if it must stay private.
- The visitor key is an unsalted daily hash of an IP network. It limits spend and is not strong anonymity. Shared networks share a limit, and rotating addresses can get around it. The global limits still apply.
- The conversation ID in `localStorage` is a bearer value for that conversation. Anyone with it can read that conversation.
- Set an AI Gateway spend limit. Application limits count actions, and one action can call a primary and a fallback model.
- With `ELEVENLABS_API_KEY` or `DEEPGRAM_API_KEY` set, stored answers are sent directly to that vendor for speech. The gateway spend limit and logs do not cover those calls. The application's speech limits still apply, so also set a credit limit on the ElevenLabs key and a usage limit or low balance in Deepgram.
- Guardrails does not enforce responses on streamed requests.
- Speech-to-text requests ask the gateway not to store audio payloads. Confirm this in gateway logs.

## Handling tokens

The application needs no API token at runtime unless Nova-3 is enabled through the optional `AI_GATEWAY_TOKEN` Worker secret or direct speech through the optional `ELEVENLABS_API_KEY` and `DEEPGRAM_API_KEY` Worker secrets. Give each speech key the narrowest permissions available and store it only as a Worker secret. A separate token is used only to configure AI Gateway. Scope it to AI Gateway, give it a short expiry, keep it out of files and command history, and revoke it after setup.
