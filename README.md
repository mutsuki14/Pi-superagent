# pi-superagent

A proactive coding agent for one repository, built on the [Pi coding agent](https://pi.dev/) SDK (`@earendil-works/pi-coding-agent`). It is a port of DeepSeek's [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) from DeepSeek Harness to Pi.

It listens to **Sources** (GitHub through the `gh` CLI, and a local file-based inbox), evaluates each request under a **Policy** (who may ask, which proactive rules apply), turns authorized requests into **Tickets**, executes each Ticket in its own Pi session and directory, and answers in the original conversation.

The guiding principle is unchanged: **take as little human attention as possible, and give as much value as possible.** The agent acts only when asked or when a written rule allows it, and speaks only when someone must act or can use a result.

## What was ported

| Layer | Status | Notes |
| --- | --- | --- |
| Domain core (`src/core`) | ✅ Verbatim | Trigger / Thread / Eval / Mandate / Ticket / Assignment / Subscription engine, with the original 144 tests passing |
| Policy (`src/policy.ts`) | ✅ | Gate, admission table, revalidation, assessment validation, policy versioning |
| Store (`src/app/store.ts`) | ✅ Rewritten | One atomic JSON file replaces SQLite (no native deps) |
| Effects queue / Outbox | ✅ | Durable, retried, ordered side effects; idempotent channel sends |
| Sessions (`src/app/sessions.ts`) | ✅ New | `SessionDriver` port + `PiSessions` on `createAgentSession`; one persistent Pi session per role/ticket |
| Executor (`src/executor/pi.ts`) | ✅ | Worker slots, prepare command, launch/delivery effects, idle → `waiting`, transient retry, turn timeout |
| Tools | ✅ | `orchestrator_*` tools for both roles, bridged from zod to Pi `ToolDefinition` |
| Assessor | ✅ | Proactive candidate cards + `orchestrator_eval*` inside the main session |
| Sources | ✅ GitHub (polling via `gh`), ✅ Inbox (local files) | Feishu was not ported |
| Prompts | ✅ | Reference prompts adapted for Pi; team sections overridable under `<stateDir>/prompts/` |
| Panel | ✅ | `--panel` serves a one-page UI (what needs a person first, tickets, threads, decisions, inbox chat, settings editor) over a JSON API |

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=...        # or any provider Pi supports; or log in with the pi CLI
npm run dev -- start --state .state --repo /path/to/checkout --panel 8787
```

In another shell, talk to it through the inbox Source (enable it first, see below):

```bash
npm run dev -- post --thread general --from alice "@agent fix the typo in README: 'recieve' -> 'receive'"
npm run dev -- thread --thread general     # see replies
npm run dev -- status
```

### Enabling Sources and allowing people

Settings live in `<stateDir>/state.json` and are edited through the panel API (or by the orchestrator on an explicit request). For the inbox:

```bash
curl -X PUT localhost:8787/api/settings/source:inbox -H 'content-type: application/json' \
  -d '{"revision":0,"value":{"enabled":true,"config":{"name":"agent"}}}'
curl -X PUT localhost:8787/api/settings/policy -H 'content-type: application/json' \
  -d '{"revision":1,"value":{"rules":[],"sources":{"inbox":{"allowed":[{"id":"alice"}]}}}}'
```

For GitHub, enable `source:github` with `{"repository":"owner/name","account":"<bot login>"}` and list allowed GitHub logins under `policy.sources.github.allowed`. The agent uses the `gh` CLI's current authentication. A `prepare` command in the `executor` block (e.g. `git -C "$PI_SUPERAGENT_REPO" worktree add "$PI_SUPERAGENT_DIR" -b "$PI_SUPERAGENT_NAME"`) creates each ticket directory.

## Development

```bash
npm run typecheck && npm test && npm run build
```

Design documents of the original project apply unchanged to the domain: see `_ref` upstream `docs/000`–`003`. Pi-specific decisions:

- **Input delivery.** Pi takes a message into the session as soon as it is accepted, so `inputsRead` is recorded at delivery.
- **Idle detection.** `agent_settled` ends a worker turn; a turn that ends without a non-progress report is reported `waiting` with the worker's last words.
- **Background jobs.** Pi has no job table; workers are told to run long commands with `&` and read their output later. The 30-minute background limit of the original is replaced by a per-turn timeout (`executor.turnTimeoutMinutes`).

## Verified

- `npm run check`: typecheck, 144 core tests and 4 end-to-end tests (a fake `SessionDriver` drives the Runtime through accept → ack → ready → reply, observe-mode ignore, follow-up resume with an attention question, and restart recovery).
- A live run with `claude-haiku-4-5` through `PiSessions` and the inbox Source: an explicit request was accepted, acknowledged, executed in a cloned worktree, committed and reported; a follow-up on the thread resumed the ended ticket without a new Eval; an explicit "stop" ended the ticket by a human stop Decision.

### Model proxies

Pi reads provider API keys from the environment but not alternate base URLs. When `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` is set and the agent directory has no `models.json`, pi-superagent writes one that routes the provider through that URL.

## Remaining work

- Feishu Source.
- GitHub Source has not been exercised against a real repository in this environment (the polling, PR binding and comment channel are implemented but untested live).
- Workers have no background job table as in DSH: long commands run with `&`; the per-turn timeout (`executor.turnTimeoutMinutes`) replaces the 30-minute background limit.

## License

MIT (the ported core carries the original MIT license).
