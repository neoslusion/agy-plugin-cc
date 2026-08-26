# gemini-plugin-cc

A Claude Code plugin that delegates work to **agy (Antigravity CLI)** via a persistent broker runtime. Enables real-time progress streaming, context transfer, phased orchestration, and native Agent tool integration for fan-out workflows.

Intended division of labor: **Claude plans and judges; agy executes fully-specified instructions** (tasks, plan steps, mechanical changes). agy is not a second opinion or a diagnostician.

## Commands

| Command | What it does |
|---------|-------------|
| `/agy:setup` | Check agy is installed + authenticated; toggle stop-review gate |
| `/agy:task` | Run a one-shot task through agy (via broker) |
| `/agy:execute-plan` | Execute a plan file step-by-step with conversation resume |
| `/agy:phased-plan` | **NEW:** Execute multi-phase plan with Claude synthesis between phases |
| `/agy:transfer` | **NEW:** Import Claude session context into agy conversation |
| `/agy:rescue` | Hand a specified task/plan step to agy for execution (agentic routing) |
| `/agy:review` | Read-only code review, schema-enforced verdict |
| `/agy:adversarial-review` | Skeptical design/security review |
| `/agy:status` | Job table for this session (`--all` for all sessions) |
| `/agy:result` | Full output of a finished job |
| `/agy:cancel` | Kill a running job |

Plus `SessionStart`/`SessionEnd` hooks and an opt-in **stop-review gate** (fails open on timeout).

## Architecture

### Broker Runtime (NEW)
- **Persistent agy broker** — `agy-broker.mjs` runs as a background process, accepting JSON-RPC over named pipe (Windows) / Unix socket
- **Bidirectional communication** — Real-time streaming of progress notifications (`step_update`, tool calls, agent responses)
- **Connection pooling** — Multiple Claude sessions can connect to the same broker for resource efficiency
- **Automatic lifecycle** — Broker starts on first task/plan invocation, stays alive for conversation resume

### Execution Modes
- **Direct spawn (default)** — Tasks run as headless `agy -p ...` children, one per job. This is naturally concurrent, which is what Agent-tool fan-out needs
- **Broker mode** — The persistent broker starts on SessionStart (`AGY_USE_BROKER=false` disables it) and executes one agy child per request, so routing jobs through it relays streaming progress without serializing fan-out

### Context Transfer
- **Claude → agy session import** — Extracts recent turns from Claude transcript and injects as context
- **Semantic filtering** — Only transfers relevant turns based on task scope
- **Automatic injection** — `AGY_TRANSCRIPT_PATH` from SessionStart hook enables transparent context flow

### Phased Orchestration
- **Multi-phase plans** — Break complex work into focused phases with verification gates
- **Claude-in-the-loop synthesis** — Verify exit criteria and inject insights between phases
- **Structured handoff** — Schema-enforced outputs enable clean data flow
- **Adaptive execution** — Abort or pivot based on intermediate results

### Native Agent Integration
- **Custom subagent types** — `agy:task`, `agy:plan-phase` registered in Agent tool
- **Fan-out workflows** — Use `Agent(subagent_type: "agy:task", schema: {...})` for parallel execution
- **Schema-based structured output** — Type-safe results for synthesis

### Core Features (Preserved)
- **Harness-managed background** — background jobs use `run_in_background: true`
- **Subagent tracking** — `invoke_subagent`/`define_subagent` tool events detected
- **Agentic delegation** — `agy-rescue` hands fully-specified tasks and plan steps to agy; Claude keeps planning, diagnosis, and judgment
- **Job store** — per-workspace state under `$CLAUDE_PLUGIN_DATA/state/`
- **Executor registry** — uniform adapter interface (`preflight`, `runTask`, `cancel`, `collectContext`)
- **Permission model** — reviews read-only; write jobs opt in with `--approve-all`

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
- **No session protocol (ACP-style transport)** — agy exposes headless mode only; the broker supervises independent stateless spawns (one child per request) rather than speaking a persistent agent protocol
- **No auto-applying review fixes** — reviews are read-only by design
