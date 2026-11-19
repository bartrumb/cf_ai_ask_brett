# Security

Codex Guard treats every submitted change, transcript and model response as untrusted.

## Controls

| Risk | Control |
| --- | --- |
| Unauthorized access or spend | Real-model mode requires Cloudflare Access, and the Worker verifies the token's signature, issuer, audience and time limits |
| Direct use of agent protocols | The socket accepts only named RPC methods, each validated by zod. Chat, state, tool and approval frames are dropped |
| Cross-site socket use | Browser connections must come from the same host |
| Prompt injection | Risk is decided before model use. Turns have no tools and no prior model text. Submitted text and paths stay in a per-request untrusted block |
| Misleading model output | Stored commentary is checked for unknown citations, skipped findings and contradictory risk claims. The spoken verdict comes from rules |
| Secret exposure | One shared pattern set drives detection and redaction for stored data, prompts, evidence, titles, live text and speech |
| Raw input retention | Workflow parameters hold only IDs, and pending input is deleted when a review ends |
| Expensive input | Input, line, path, question and audio sizes are capped. Audio must be 30 seconds or less of 16 kHz mono PCM |
| Cost abuse | Connection, per-connection, per-repository and shared per-minute limits apply, with AI Gateway limits above them |
| Script injection | The UI renders text nodes only, under a restrictive Content Security Policy |

## Remaining risks

- People admitted by Access share all repositories. Add per-repository authorization before using this for separate teams.
- AI Gateway logs contain redacted prompts. Pattern-based redaction can miss an unfamiliar secret format, so do not submit real credentials.
- Guardrails is set to flag prompt injection. It does not enforce responses on streamed requests.
- Set an AI Gateway spend limit. The application limits slow usage but are not a dollar budget.
- Repository data has no automatic expiry beyond the stored review and message caps.
- Speech-to-text requests ask the gateway not to store audio payloads. Confirm this in gateway logs before handling sensitive audio.

## Handling tokens

The application needs no API token at runtime. A token is used only to configure AI Gateway. Follow the PowerShell steps in the README, scope it to AI Gateway, set a short expiry, and revoke it after setup.
