# gemini-plugin-cc

A Claude Code plugin that delegates work to **external agent CLIs** running locally. Claude orchestrates; [Antigravity CLI (`agy`)](https://antigravity.google/download) executes. An executor registry lets other CLIs (codex, etc.) plug in later.

## Commands

| Command | What it does |
|---------|-------------|
| `/agy:setup` | Check agy is installed + authenticated; toggle stop-review gate |
| `/agy:task` | Run a one-shot task through agy |
| `/agy:execute-plan` | Execute a plan file step-by-step with conversation resume |
| `/agy:rescue` | Delegate a task via the `agy-rescue` subagent (proactive routing) |
| `/agy:review` | Read-only code review, schema-enforced verdict |
| `/agy:adversarial-review` | Skeptical design/security review |
| `/agy:status` | Job table for this session (`--all` for all sessions) |
| `/agy:result` | Full output of a finished job |
| `/agy:cancel` | Kill a running job |

Plus `SessionStart`/`SessionEnd` hooks and an opt-in **stop-review gate** (fails open on timeout).

## Architecture

- **One headless agy process per job** — `agy -p ... --output-format stream-json`. No broker, no named pipes. Conversation resume via `--conversation <id>`.
- **Harness-managed background** — background jobs use `run_in_background: true` on Bash calls so the harness sends a `<task-notification>` on completion. True fan-out: launch multiple agy jobs in parallel without blocking.
- **Subagent tracking** — `invoke_subagent`/`define_subagent` tool events are detected in the stream and surfaced as named progress entries with counts.
- **Proactive delegation** — `agy-rescue` agent routes substantial tasks to agy autonomously, without waiting for an explicit user request.
- **Job store** — per-workspace state under `$CLAUDE_PLUGIN_DATA/state/`: records, logs, phase tracking, 50-job pruning.
- **Executor registry** — `scripts/lib/executors/`: uniform adapter interface (`preflight`, `runTask`, `cancel`, `collectContext`).
- **Structured output** — native `agy --json-schema` for reviews and the stop-review gate.
- **Permission model** — reviews are always read-only; write jobs opt in per-run with `--approve-all`.

## Requirements

- `agy` on PATH — install from https://antigravity.google/download
- Run `agy` interactively once to authenticate (Google account / AI credits)
- No API key or OAuth in this plugin — credentials stay inside the agy binary

## Install

From a terminal (not inside Claude Code):

```bash
git clone https://github.com/neoslusion/agy-plugin-cc
cd agy-plugin-cc
node scripts/dev/install.mjs
```

The installer registers this directory as a marketplace, installs and enables
the plugin (names are read from `.claude-plugin/*.json`, so it stays correct
across renames), and tolerates re-runs.

Manual equivalent:

```bash
claude plugin marketplace add /path/to/agy-plugin-cc
claude plugin install agy@gemini-plugin-cc
claude plugin enable agy@gemini-plugin-cc
```

Verify anytime with the doctor:

```bash
node scripts/dev/install.mjs --check
```

Checks marketplace registration, installed version vs manifest, enablement,
and that the `agy` CLI is on PATH. Then run `/agy:setup` inside Claude Code to
confirm agy auth.

Stop-review gate is off by default. Enable with `/agy:setup --enable-review-gate`.

## Development

```bash
npm test
```

Unit tests run offline against the `fake-agy` fixture. Integration tests self-skip when the binary or credentials are missing.

## Deliberate non-features

- **No session-transcript import** — no agy equivalent of ACP `externalAgentConfig/import`
- **No broker/socket transport** — agy exposes headless mode only; stateless spawn is simpler
- **No auto-applying review fixes** — reviews are read-only by design
