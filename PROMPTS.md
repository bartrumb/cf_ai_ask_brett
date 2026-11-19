# Prompt history

Every prompt given to the AI coding assistant (Claude Code) while building this
repository, verbatim and in order, with a short note of what each produced.

Redactions are marked `[REDACTED: ...]`. Nothing else has been changed.

---

## Prompt 1

````text
Task (from the session that started this one):
Background (from the session that started this one):
The user is preparing an optional public portfolio assignment for a Cloudflare engineering application focused on developer productivity, CI/CD, GitOps, MCP, agents, evals, and policy-as-code. The assignment asks for a GitHub repository showing an AI-powered Cloudflare app with an LLM, coordination, chat or voice input, and memory or state. AI-assisted coding is allowed, but prompt history must be submitted, so this session must stay clean and shareable. Do not use employer material or private project details.

Task:
Build a small, polished AI-powered application on Cloudflare in a new standalone git repository at `C:\Code\codex-guard-agent`. Do not put it inside the current project.

App idea: **Codex Guard**, a chat agent that helps an engineer check a proposed code or infrastructure change against a team's engineering standards before opening a pull request.

Required by the assignment:
- LLM: use Workers AI through the `AI` binding. Check the current model catalog before choosing a model.
- Workflow or coordination: use the Cloudflare Agents SDK with a Durable Object agent, plus a Cloudflare Workflow for the multi-step review.
- User input through chat: a simple, usable web chat UI served from the Worker or Pages.
- Memory or state: each repository or conversation keeps its standards, past reviews, and accepted exceptions.

Behavior:
1. The user pastes a change summary or unified diff.
2. Deterministic rules decide the risk level and which standards apply. The model must not decide the risk level.
3. The model explains the findings, cites the matching sample standard, and suggests concrete fixes.
4. The user can accept a finding as an exception with a reason, and later reviews remember it.
5. The UI streams progress and clearly shows rule results separately from AI commentary.

Use only invented sample standards and sample diffs. Treat pasted diffs as untrusted input, cap input size, and do not let their contents override instructions or rule results.

Before coding, read the current docs at `https://developers.cloudflare.com/agents/llms.txt`, and prefer the current recommended APIs. Keep the design simple.

Prompt history is a required deliverable. Create `PROMPTS.md` at the start. Record every prompt the user gives in this session verbatim, in order, beginning with this brief, with a short note of what each produced. Do not invent or tidy prompts. Keep private information out of the repository and prompt history, and warn the user if a prompt contains something that should be redacted.

Done means:
- TypeScript checks and automated tests pass, including rule logic, exception memory, malformed input, and prompt-injection text in a diff.
- The app runs locally with Wrangler and you verify the main chat flow in a browser.
- `README.md` explains what it does, the architecture, local setup, deployment, and how each assignment requirement is met.
- The repository has clean commits.

Do not create a GitHub repository, push, deploy, or use real secrets without the user's explicit approval. When local work is verified, report what passed and what still needs approval.

Shared notes folder for this group of sessions (outside the repo; read siblings' notes there, leave hand-over notes or large findings there instead of pasting them into messages): [REDACTED: local folder path containing a Windows user name]
````

**Produced:** this repository: the rule engine, Durable Object agent, review Workflow, chat UI, tests and documentation.

---

## Prompt 2

````text
Lets setup cloudflare AI gateway and use
Primary TTS: @cf/deepgram/aura-2-en
Secondary TTS: @cf/myshell-ai/melotts
Primary SST: @cf/deepgram/nova-3
Secondary SST: @cf/deepgram/flux
Primary LLM: @cf/deepseek-ai/deepseek-v4-pro-0813
Secondary LLLM: @cf/thinkingmachines/inkling-2-small
Reference these resources: https://developers.cloudflare.com/ai-gateway/llms-full.txt
https://developers.cloudflare.com/agents/llms-full.txt
We should configure all of the models to go through the gateway so we can monitor spend and prompt injections.
````

**Produced:** research into AI Gateway and the requested models. It found that two of them are scheduled for removal on 2026-11-20 and that Flux is WebSocket-only, which led to Prompt 3.

---

## Prompt 3

````text
Primary LLM: @cf/deepseek-ai/deepseek-v4.1-flash-1017
Secondary SST: @cf/openai/whisper-large-v3-turbo
Swap these out then
````

**Produced:** the requested language-model and speech-to-text swaps, AI Gateway routing for every model with fallbacks and request metadata, a gateway setup script that flags prompt injection, voice input, spoken results, tests and documentation.

---

## Prompt 4

````text
I recently wrote a post about always-on-agents reference this https://github.com/bartrumb/always-on-agent-cloudflare
As I need this agent to be durable so utilize the Think Harness, use zod for input schemas, also be sure to document all of your code for future engineers, ensure 80% test coverage, look for security risks. Since we are windows give me back secure commands to set these tokens proper. Yes replace MeloTTS with aura-1 if that is the better fit but be sure to see when it expires as we may need to a pick a third party option instead
````

**Produced:** migration to the Think harness with a durable question inbox, zod schemas for inputs, source documentation, an 80% coverage gate across server and browser code, an independent security review with fixes, Cloudflare Access enforcement, `aura-1` as the speech fallback, and secure Windows commands for setting tokens. The assistant delegated the documentation pass and the security review to subagents. It gave them no additional user prompts.

---

## Prompt 5

````text
<!-- attach: Terminal | tab:0 -->
> PowerShell 7.6.10
> PS C:\Code\bartrum-family> $env:CLOUDFLARE_ACCOUNT_ID = Read-Host "Cloudflare account ID"
> Cloudflare account ID: [REDACTED: Cloudflare account ID]
> PS C:\Code\bartrum-family> $env:CLOUDFLARE_API_TOKEN = Read-Host "Cloudflare API token" -MaskInput
> Cloudflare API token: *****************************************************
> PS C:\Code\bartrum-family> npm run gateway:apply
> npm error Missing script: "gateway:apply"
> npm error
> npm error To see a list of scripts, run:
> npm error   npm run
> npm error A complete log of this run can be found in: [REDACTED: local log path containing a Windows user name]
> PS C:\Code\bartrum-family>

Looks like NPM run didn't working . Lets get this working and also review the security issues ensure all 12 of the findings are addressed, once all of this underlying backend is fully deployed and working we will then customize the sites UI and Prompts.
````

**Produced:** the corrected gateway commands, a second and third security pass, fixes for the confirmed findings, daily AI limits, Access session checks and data expiry.

---

## Prompt 6

````text
[REDACTED: attached personal knowledge-base file path]

[REDACTED: pasted personal message about that knowledge base]

Since the other session could read my claude code sessions can you see if you can reach them since you are running inside claude code. Take this attachment as the start and see what else you can find and add.
````

**Produced:** work outside this repository on a private personal knowledge base. It did not change the application.
