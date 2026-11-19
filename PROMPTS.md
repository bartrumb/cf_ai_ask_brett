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
