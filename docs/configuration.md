# Configuration

Installation puts the plugin in your host. Project configuration decides which agents run, with
which models, and how work is routed. The generated `.agent-delegation.json` is ordinary project
configuration; review it before running in a checkout you did not author.

## Initial setup

From the checkout, after installing the plugin:

```sh
node scripts/agent-runner.mjs configure --cwd /path/to/project --host codex
```

Use `--host claude` for Claude Code. Setup creates a starter `.agent-delegation.json`, adds an
orchestration instruction block to `AGENTS.md` or `CLAUDE.md`, and generates native role
definitions into `.codex/agents/` or `.claude/agents/`. Existing instructions and unrelated agent
files are preserved. `--dry-run` previews changes, and edited generated agents are reported instead
of overwritten. Reconfigure after changing roles, or let `start` synchronize them.

Then launch the configured orchestrator:

```sh
node scripts/agent-runner.mjs start --cwd /path/to/project
node scripts/agent-runner.mjs start --cwd /path/to/project --dry-run
```

`start` synchronizes native agents and opens the existing interactive CLI with the configured
model and effort flags. The dry run prints the exact binary and arguments. It does not change
global model or permission settings. You can also open Codex or Claude normally; project
orchestration instructions still apply. A running host session does not change models when the
configuration file is edited.

## Roles

The orchestrator owns the conversation, integration and completion. Optional roles provide
bounded help:

| Role | Purpose |
| --- | --- |
| `planner` | Prepares a plan when useful. |
| `advisor` | Provides an on-demand second opinion. |
| `executor` | Implements scoped changes. |
| `reviewer` | Checks a result independently. |
| `explorer` / `tester` | Read-only investigation and verification via `purpose`. |

A recognized role name supplies its purpose; aliases such as `implement` and `review` also work.
Custom names default to executor unless a purpose is supplied. These are optional roles, not a
fixed sequence for every task.

The starter leaves model names unset to use each harness's own defaults. [The example
configuration](../examples/agent-delegation.json) shows explicit choices; use models available
through your accounts:

```json
{
  "orchestrator": {
    "host": "codex",
    "model": "gpt-6-luna",
    "effort": "medium",
    "instructions": "Plan and verify in the parent; delegate bounded implementation tasks."
  },
  "automation": { "mode": "auto", "maxParallel": 4 },
  "defaultExecutor": "opencode",
  "executors": {
    "opencode": { "model": "opencode/glm-5.3-flash-free" },
    "codex": { "effort": "high" },
    "claude": { "effort": "high" }
  },
  "roles": {
    "planner": { "executor": "codex", "transport": "auto", "model": "gpt-6-luna" },
    "advisor": { "executor": "claude", "transport": "auto" },
    "executor": { "executor": "opencode" },
    "reviewer": { "executor": "codex", "transport": "auto", "model": "gpt-6-luna", "effort": "low" }
  }
}
```

## Executor and role fields

Executor and role entries accept:

| Field | Meaning |
| --- | --- |
| `model` | Provider model name. |
| `effort` | Reasoning effort; an OpenCode model variant. |
| `agent` | Provider-side agent profile (agy, Claude and OpenCode CLI only). |
| `advisor` | Claude CLI advisor model. |
| `timeoutMs` | Per-task executor timeout. |
| `integration` | `cli`, Codex `app-server`, Claude `agent-sdk`, or Antigravity `acp`. |

Roles additionally accept `executor`, `transport`, `purpose`, extra `instructions`, `advisorRole`
and `advisorRounds`. Explicit CLI options override role options, then executor defaults. Changing
`--executor` discards the previous executor's model options while preserving the role contract.

| Transport | Behavior |
| --- | --- |
| `auto` | Native when the role's executor matches the current host; CLI otherwise. |
| `native` | Requires the matching host and its generated agent definition. |
| `cli` (default) | External runner task using the selected `integration`. |

`route --role advisor --host codex` reports the resolved transport, model options and role
instructions. A role mapped to another provider still requires that provider's CLI and credentials.
Native availability and permission enforcement depend on the host's active policy.

## Provider notes

The starter executor is [OpenCode](https://opencode.ai), driven through
`opencode run --format json`. Any model listed by `opencode models` works, including its free
models; some free models may use submitted data for training, so check the
[model list](https://opencode.ai/docs/zen/) before sending private code. OpenCode has no
schema-constrained output, so it cannot fill the supervisor's planner, executor or reviewer roles.
The starter points `supervisor.executorRole` at a host-backed `implementer` role, and `run`
rejects a supervisor role without structured output before it starts. Read-only roles run on
OpenCode's `plan` agent, and writers get `--auto` only with `--approve-all`.

agy remains available but is opt-in. Google's [Antigravity FAQ](https://antigravity.google/docs/faq)
says wrapping agy inside third-party coding agents is not supported under consumer plans, and a
Google forum moderator [confirmed](https://discuss.ai.google.dev/t/187241) on 2026-10-08 that
orchestrating agy from Codex or Claude Code under a consumer login can trigger account suspension.
Use agy here only with a Gemini API key or Enterprise login; `providers` reports this as a `policy`
warning. The ACP route requires a separately installed runtime; see
[ACP setup](antigravity-acp-setup.md).

## Advisor options

`advisor` passes `--advisor <model>` to a Claude CLI worker, so a cheap worker can consult a
stronger model at decision points, for example
`{ "executor": "claude", "model": "haiku", "advisor": "opus" }`. The pairing must be one Claude
Code accepts, and the advisor needs Claude Code's feature-flag fetching. With
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_TELEMETRY` set, Claude Code drops it
silently, and the task result carries a notice saying the advisor is likely off. Results report
`advisorCalls`. A parent Claude session's own `/advisor` needs no configuration here; it already
sees every delegation result.

`advisorRole` gives any worker an advisor in the spirit of Claude Code's advisor tool, with any
executor on either side:

```json
"roles": {
  "worker": { "executor": "opencode", "model": "opencode/glm-5.3-flash-free", "advisorRole": "coach", "advisorRounds": 2 },
  "coach": { "executor": "claude", "model": "opus" }
}
```

- **Worker asks.** CLI workers get a `consult_advisor` tool through a per-task MCP server: Claude
  through `--mcp-config`, Codex through `-c mcp_servers...`, OpenCode through
  `OPENCODE_CONFIG_CONTENT` with `--standalone`, because its background service never sees
  per-run configuration. The advisor receives the assignment, the worker's recorded transcript
  and the question, and answers read-only. A task may consult it four times.
- **Advisor reviews.** Workers often do not ask, so every finished turn is also reviewed against
  the assignment, the workspace diff and the transcript. The advisor replies `APPROVE`, `REVISE`
  or `ESCALATE`. Guidance from `REVISE` resumes the worker's own session, at most
  `advisorRounds` times (0–5, default 2). A failed turn or a handoff containing a `BLOCKED:` line
  is reviewed the same way, to recover or to answer the question.
- **The parent decides.** `result.advisor` reports the reviews, the final verdict, consultations,
  and any `escalation`, `unresolved` guidance or `unavailable` error. An advisor failure never
  fails the worker. Advisor approval is evidence, not acceptance.

The advisor role cannot have its own advisor. Reviews run for every integration; the consult tool
is injected into CLI workers only. Supervisor runs do not use advisor roles yet.

## Automation

Set `automation.mode` to `manual` for explicit delegation only. `maxParallel` bounds the host's
orchestration policy across native and CLI work; `start` also sets Codex's native concurrency
limit. There is no cross-process semaphore for independent generic runner calls. Supervisor mode
enforces `supervisor.maxWorkers`, isolates every writer, and integrates only evidence-approved
patches.

## Direct runner

The runner also works directly from the checkout or a packaged plugin:

```sh
node scripts/agent-runner.mjs executors
node scripts/agent-runner.mjs config --cwd /path/to/project
node scripts/agent-runner.mjs setup --executor codex
node scripts/agent-runner.mjs route --cwd /path/to/project --role advisor --host codex
node scripts/agent-runner.mjs task --cwd /path/to/project --session-id codex:my-session --role executor --prompt-file /path/to/task.txt --json
node scripts/agent-runner.mjs review --executor claude --base main --json
```

`--prompt-file` preserves newlines, quotes and shell metacharacters. Inline prompts are also
supported; use `--` before inline text that begins with flags. `--json-schema` accepts a JSON
schema file or inline JSON object and returns parsed output in `structuredOutput`.

`task --role planner` asks a worker to prepare a plan. The older `plan` subcommand executes an
existing plan. `review --role reviewer` collects a Git diff and requests structured review output;
`task --role reviewer` handles a custom review question. CLI dispatch includes the role contract
automatically. Native routes must be dispatched with the host's agent tool; explicit `--executor`
selects CLI transport instead.

The result includes `status`, `response`, `error`, `conversationId`, `usage` and job metadata.
Progress and raw CLI output are recorded in the job log. A missing terminal result, nonzero exit
or executor-reported failure produces failure. Codex and Claude additionally reject malformed
event streams; the existing agy parser tolerates non-JSON diagnostic lines. `changedFiles` is
best-effort reporting, not proof of which files were edited; the parent must inspect the diff.

For follow-up work, use the returned conversation ID:

```sh
node scripts/agent-runner.mjs task --executor codex --conversation <id> --prompt-file follow-up.txt --json
node scripts/agent-runner.mjs status --session-id codex:my-session --json
node scripts/agent-runner.mjs result <job-id> --json
node scripts/agent-runner.mjs cancel <job-id>
```

Keep `--cwd` and the state-directory environment consistent between calls. Set
`AGENT_DELEGATION_DATA` to use one state directory across hosts. Otherwise the runner uses
`CLAUDE_PLUGIN_DATA` or `PLUGIN_DATA` when provided, then a per-user data directory:
`%LOCALAPPDATA%\agent-delegation` on Windows,
`~/Library/Application Support/agent-delegation` on macOS, or
`$XDG_STATE_HOME/agent-delegation` (default `~/.local/state/agent-delegation`) on Linux. State
left in the old temporary directory is moved on first use. Use a stable `--session-id` to isolate
each parent's jobs. `--resume` selects the newest terminal task/plan for that parent, executor,
integration and optional role. Explicit conversation IDs are preferable when several tasks run in
parallel. Send turns within one conversation sequentially.

The foreground `task` compatibility command can use the host's background tools; `delegate`
manages a detached worker directly. Independent executor conversations can run concurrently;
concurrent writers should have disjoint files or separate worktrees. Generic runner calls do not
merge or revise work automatically. Supervisor mode owns worktrees, bounded revisions, patch
integration and evidence checks. Terminal dispatches retain results and retry identities; legacy
foreground history keeps active jobs and the 50 newest terminal jobs. Logs can contain task
context and are stored locally.
