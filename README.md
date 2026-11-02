# Agent Delegation

Terminal-first orchestration for your installed **OpenCode**, **Codex**, **Claude Code** and **agy** agents, inside a **Codex or Claude Code** host session. Configure your orchestrator, planner, advisor, executor and reviewer models; your existing host plans, delegates, verifies and follows up. The plugin provides a shared skill and a small Node.js runner, with a T3-inspired task view, asynchronous dispatch and portable context. CLI execution stays the default; optional Codex App Server, Claude Agent SDK and Antigravity ACP adapters add provider events and active-task controls.

This extends the original agy plugin. Existing `/agy:*` commands and their installer remain available; see [legacy documentation](docs/legacy-agy.md).

The repository and local marketplace keep the historical `agy-plugin-cc` name so existing installs keep resolving; the installable plugin and package are `agent-delegation`.

## Install

Requirements: Node.js **22.18+** (or 24+), a supported host, and whichever executor CLIs you intend to use. Authenticate each CLI normally before delegation. Only installed executors you select are required.

From this checkout:

```text
npm ci
node scripts/dev/install-delegation.mjs codex
node scripts/dev/install-delegation.mjs claude
```

Use `both` to install into both hosts. The installer packages a self-contained `plugins/agent-delegation` directory, registers this checkout as a local marketplace, and installs the plugin. It does not replace your existing agy plugin or select the host's model. Start a new session after installation.

To package without installing:

```text
npm run package
```

For a temporary Claude Code session after packaging:

```text
claude --plugin-dir ./plugins/agent-delegation
```

For automatic orchestration, configure the project once after installing:

```text
node scripts/agent-runner.mjs configure --cwd /path/to/project --host codex
```

Use `--host claude` for Claude Code. Setup creates a starter `.agent-delegation.json`, adds an orchestration instruction block to AGENTS.md or CLAUDE.md, and generates native role definitions. Existing instructions and unrelated agent files are preserved. Use `--dry-run` to preview; edited generated agents are reported instead of overwritten. Reconfigure after changing roles, or use `start` below to synchronize them automatically.

Then prompt normally: "Implement this feature" or "Investigate and fix this bug." The host uses configured workers when they help and handles small tasks directly. You can still invoke `$delegate` in Codex or `/agent-delegation:delegate` in Claude Code, request a particular worker, or say "do this yourself." Automatic delegation depends on the active model and host policy; it is not a deterministic scheduler.

Other local coding harnesses can invoke the runner or load the skill if they support local scripts. Their plugin installation formats are not covered by this release. External CLI jobs do not share the parent's transcript or native agent lifecycle.

## Configure the orchestrator and executors

Edit the generated `.agent-delegation.json`, then launch your configured orchestrator:

```text
node scripts/agent-runner.mjs start --cwd /path/to/project
node scripts/agent-runner.mjs start --cwd /path/to/project --dry-run
```

`start` synchronizes native agents and opens the existing interactive CLI with model/effort flags. The dry run prints the exact binary and arguments. No global model or permission settings are changed. You can also launch Codex or Claude normally with your preferred model; project orchestration instructions still apply. A running host session does not change models when you edit this file.

## Terminal task workflow

External workers can run asynchronously while you continue in your native coding host:

```text
node scripts/agent-runner.mjs delegate --session-id demo --executor claude --prompt-file task.md --request-id implement-1 --json
node scripts/agent-runner.mjs tasks --session-id demo
node scripts/agent-runner.mjs watch TASK_ID --session-id demo --timeout-ms 10000
node scripts/agent-runner.mjs wait TASK_ID --session-id demo --json
node scripts/agent-runner.mjs follow-up TASK_ID --session-id demo --executor codex --prompt-file follow-up.md --json
```

`delegate` returns a task ID immediately. The shared task view includes supervisor runs and their workers. Wait timeouts leave work active; event watching makes no model calls. A same-provider follow-up reuses its native session and pinned context; a provider switch builds an explicit handoff. Repeating a request ID retrieves the existing task instead of launching another worker. Write approval remains explicit for each dispatch.

Read the [terminal workflow](docs/terminal-workflow.md) for role routing, result states, retry keys and controls. Generic writers use the supplied directory; supervisor mode below provides worktree isolation and acceptance gates. Native agents remain in their host's task view. Completion hooks report events on your next prompt. This is a T3-inspired terminal workflow, not full T3 application parity.

In Claude Code the plugin also provides these commands as MCP tools (`mcp__plugin_agent-delegation_delegation__*`): `delegate_task`, `task_follow_up`, `task_status`, `task_wait`, `task_steer`, `task_interrupt`, `task_cancel` and `delegation_capabilities`. Tasks are scoped to the Claude session and share state with the runner, so `tasks` shows them too. `delegate_task` and `task_follow_up` return a `wakeCommand` (`wait TASK_ID --wake`) that blocks until the task has a result, needs input, or loses its worker. The host runs it as a background Bash command and ends its turn; the command's exit re-invokes the host, including in `claude -p`. Allow it with the permission rule `Bash(AGENT_DELEGATION_DATA=*)`. Codex hosts keep the runner commands and next-prompt hooks.

Use `doctor --session-id demo` to diagnose interrupted work and `providers --probe --json` to inspect configured providers and model catalogs. An explicit `doctor TASK_ID --repair` records a failed attempt only after its recorded worker and provider processes have exited; follow up after inspecting its files. See [task management](docs/task-management.md) for recovery rules, readiness limits and ordinary-prompt evaluations.

## Supervisor mode

The explicit supervisor owns the next-step loop instead of relying on the host model to remember when to delegate:
The worker worktree contains tracked files from the selected commit, not ignored dependencies, credentials, or uncommitted parent files. Provision the repository before running if the executor needs local dependencies; the supervisor does not create junctions or copy secrets automatically.

```text
node scripts/agent-runner.mjs run --cwd /path/to/project --task-file task.md --approve-all --json
```

The supervisor validates a bounded plan with unique step IDs and explicit file ownership, creates one detached Git worktree per step, and dispatches up to `maxWorkers` tasks concurrently. Every worker must return the typed task-result contract, and every non-empty patch receives its own configured checks and independent structured review. Accepted patches are applied centrally and in order; overlapping ownership, out-of-scope edits, failed evidence, or patch conflicts stop integration. Failed evidence creates a bounded revision. The parent checkout must be a committed Git repository; use `--allow-dirty` only when the caller explicitly accepts that uncommitted parent state is not part of the worker baseline.

`--no-integrate` runs the complete plan/fan-out/review/verification loop without modifying the parent checkout. `--max-iterations N` bounds revisions and `--max-workers N` is the real concurrent worker limit. Parallel plan steps must declare non-overlapping owned paths. `--approve-all` is still required for write-capable executors; planner and reviewer roles remain read-only. The supervisor does not treat a worker response, changed-file hint, or reviewer claim as proof without typed results and the configured checks.

Supervisor checkpoints are stored with the normal job state. Use `run --resume --supervisor-id ID --json` to continue an interrupted run without rerunning completed child jobs. `cancel SUPERVISOR_ID` marks the run cancelled and terminates verified child process trees. Logs and prompts can contain task context and are stored locally.

Configure `supervisor.verifyCommands` as an array of argv arrays, for example `[["npm", "test"]]`. Every task must return valid structured output, produce a non-empty in-scope patch, pass its checks, and receive reviewer approval before any patch is integrated. All configured checks run again after central integration. Semantic correctness still requires appropriate acceptance criteria; the supervisor provides evidence gates, not a proof of arbitrary software behavior.

The starter leaves model names unset to use each harness's own defaults. [This example](examples/agent-delegation.json) shows explicit choices; use models available through your accounts:

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

The orchestrator owns the conversation, integration, and completion. The planner prepares a plan when useful; the advisor provides an on-demand second opinion; the executor implements scoped changes; the reviewer checks the result independently. These are optional roles, not a fixed sequence for every task. Explorer and tester purposes are also supported.

The starter executor is [OpenCode](https://opencode.ai), driven through `opencode run --format json`. Any model listed by `opencode models` works, including its free models; some free models may use submitted data for training, so check the [model list](https://opencode.ai/docs/zen/) before sending private code. OpenCode has no schema-constrained output, so it cannot fill the supervisor's planner, executor or reviewer roles; the starter points `supervisor.executorRole` at a host-backed `implementer` role, and `run` rejects a supervisor role without structured output before it starts. Read-only roles run on OpenCode's `plan` agent, and writers get `--auto` only with `--approve-all`.

agy remains available but is opt-in. Google's [Antigravity FAQ](https://antigravity.google/docs/faq) says wrapping agy inside third-party coding agents is not supported under consumer plans, and a Google forum moderator [confirmed](https://discuss.ai.google.dev/t/187241) on 2026-10-08 that orchestrating agy from Codex or Claude Code under a consumer login can trigger account suspension. Use agy here only with a Gemini API key or Enterprise login; `providers` reports this as a `policy` warning.

Executor and role entries accept `model`, `effort` (an OpenCode model variant), `agent` (agy, Claude and OpenCode CLI only), `advisor` (Claude CLI only), `timeoutMs`, and `integration` (`cli`, Codex `app-server`, Claude `agent-sdk`, or Antigravity `acp`). Roles additionally accept `executor`, `transport`, `purpose`, and extra `instructions`. A recognized role name supplies its purpose; aliases such as `implement` and `review` also work. Custom names default to executor unless a purpose is supplied. Explicit CLI options override role options, then executor defaults. Changing `--executor` discards the previous executor's model options while preserving the role contract.

`advisor` passes `--advisor <model>` to a Claude CLI worker, so a cheap worker can consult a stronger model at decision points, for example `{ "executor": "claude", "model": "haiku", "advisor": "opus" }`. The pairing must be one Claude Code accepts, and the advisor needs Claude Code's feature-flag fetching: with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_TELEMETRY` set, Claude Code drops it silently, and the task result carries a notice saying the advisor is likely off. Results report `advisorCalls`. A parent Claude session's own `/advisor` needs no configuration here; it already sees every delegation result.

### Advisor roles for any worker

`advisorRole` gives any worker an advisor in the spirit of Claude Code's advisor tool, with any executor on either side:

```json
"roles": {
  "worker": { "executor": "opencode", "model": "opencode/glm-5.3-flash-free", "advisorRole": "coach", "advisorRounds": 2 },
  "coach": { "executor": "claude", "model": "opus" }
}
```

- **Worker asks.** CLI workers get a `consult_advisor` tool through a per-task MCP server: Claude through `--mcp-config`, Codex through `-c mcp_servers...`, OpenCode through `OPENCODE_CONFIG_CONTENT` with `--standalone`, because its background service never sees per-run configuration. The advisor receives the assignment, the worker's recorded transcript and the question, and answers read-only. A task may consult it four times.
- **Advisor reviews.** Workers often do not ask, so every finished turn is also reviewed against the assignment, the workspace diff and the transcript. The advisor replies `APPROVE`, `REVISE` or `ESCALATE`. Guidance from `REVISE` resumes the worker's own session, at most `advisorRounds` times (0–5, default 2). A failed turn or a handoff containing a `BLOCKED:` line is reviewed the same way, to recover or to answer the question.
- **The parent decides.** `result.advisor` reports the reviews, the final verdict, consultations, and any `escalation`, `unresolved` guidance or `unavailable` error. An advisor failure never fails the worker. Advisor approval is evidence, not acceptance.

The advisor role cannot have its own advisor. Reviews run for every integration; the consult tool is injected into CLI workers only. Supervisor runs do not use advisor roles yet.

| Transport | Behavior |
| --- | --- |
| `auto` | Native when the role's executor matches the current host; CLI otherwise |
| `native` | Requires the matching host and its generated agent definition |
| `cli` (default) | External runner task using the selected `integration` |

`route --role advisor --host codex` reports the resolved transport, model options, and role instructions. Native definitions are generated into `.codex/agents/` and `.claude/agents/`. A role mapped to another provider still requires that provider's CLI and credentials. Native availability and permission enforcement depend on the host's active policy.

Set `automation.mode` to `manual` for explicit delegation only. `maxParallel` bounds the host's orchestration policy across native and CLI work; `start` also sets Codex's native concurrency limit. There is no cross-process semaphore for independent generic runner calls. Supervisor mode enforces `supervisor.maxWorkers`, isolates every writer, and integrates only evidence-approved patches.

## Run from any local host

The runner also works directly from the checkout:

```text
node scripts/agent-runner.mjs executors
node scripts/agent-runner.mjs config --cwd /path/to/project
node scripts/agent-runner.mjs setup --executor codex
node scripts/agent-runner.mjs route --cwd /path/to/project --role advisor --host codex
node scripts/agent-runner.mjs task --cwd /path/to/project --session-id codex:my-session --role executor --prompt-file /path/to/task.txt --json
node scripts/agent-runner.mjs review --executor claude --base main --json
```

`--prompt-file` preserves newlines, quotes, and shell metacharacters. Inline prompts are also supported; use `--` before inline text that begins with flags. `--json-schema` accepts a JSON schema file or inline JSON object and returns parsed output in `structuredOutput`.

`task --role planner` asks a worker to prepare a plan. The older `plan` subcommand executes an existing plan. `review --role reviewer` collects a git diff and requests structured review output; `task --role reviewer` handles a custom review question. CLI dispatch includes the role contract automatically. Native routes must be dispatched with the host's agent tool; explicit `--executor` selects CLI transport instead.

The result includes `status`, `response`, `error`, `conversationId`, `usage`, and job metadata. Progress and raw CLI output are recorded in the job log. A missing terminal result, nonzero exit, or executor-reported failure produces failure. Codex and Claude additionally reject malformed event streams; the existing agy parser tolerates non-JSON diagnostic lines. `changedFiles` is best-effort reporting, not proof of which files were edited; the parent must inspect the diff.

For follow-up work, use the returned conversation ID:

```text
node scripts/agent-runner.mjs task --executor codex --conversation <id> --prompt-file follow-up.txt --json
node scripts/agent-runner.mjs status --session-id codex:my-session --json
node scripts/agent-runner.mjs result <job-id> --json
node scripts/agent-runner.mjs cancel <job-id>
```

Keep `--cwd` and the state-directory environment consistent between calls. Set `AGENT_DELEGATION_DATA` to use one state directory across hosts. Otherwise the runner uses `CLAUDE_PLUGIN_DATA` or `PLUGIN_DATA` when provided, then the system temporary directory. Use a stable `--session-id` to isolate each parent's jobs. `--resume` selects the newest terminal task/plan for that parent, executor, integration, and optional role. Explicit conversation IDs are preferable when several tasks run in parallel. Send turns within one conversation sequentially.

The foreground `task` compatibility command can use the host's background tools; `delegate` manages a detached worker directly. Independent executor conversations can run concurrently; concurrent writers should have disjoint files or separate worktrees. Generic runner calls do not merge or revise work automatically. Supervisor mode owns worktrees, bounded revisions, patch integration, and evidence checks. Terminal dispatches retain results and retry identities; legacy foreground history keeps active jobs and the 50 newest terminal jobs. Logs can contain task context and are stored locally.

## Permissions

The generic runner requires explicit `--approve-all` for autonomous write/tool execution. It does not inherit bypass permissions from the parent or the legacy agy plugin. CLI integrations use the executor's permission bypass, including sandbox bypass for Codex; rich interfaces apply provider-specific permission handling described below. Use it only for a task already authorized at that scope; `--no-approve-all` keeps it off. Planner, advisor, explorer, monitor and reviewer roles suppress bypass flags even when supplied. Review subcommands also suppress bypass independently of the selected role.

Without approval, Codex uses its read-only sandbox; Claude uses plan mode with a read-only tool inventory; OpenCode uses its `plan` agent; agy uses its headless permission handling. Claude SDK writers authorize their bounded tool inventory through SDK permission callbacks; questions are reported as blockers. ACP requires advertised permission modes and a separately installed endpoint. The parent still verifies results. Authentication and provider policy remain controlled by each provider.

The legacy agy commands retain their existing approval settings. The new plugin does not enable a stop-review gate or start the legacy broker. Workers receive `AGENT_DELEGATION_WORKER=1` to prevent recursive delegation through this runner and the legacy hooks.

## Development

On Windows, use `node scripts/agent-runner.mjs acp-setup --check` to locate the dedicated Antigravity ACP runtime, or `acp-setup --install` to download it when missing. The ACP adapter discovers the default project-local installation automatically. See [ACP setup](docs/antigravity-acp-setup.md) for custom paths, authentication limits and the current validation status.

See [provider coordination](docs/provider-coordination.md) for shared context revisions, completion hooks, live controls and optional failure-triggered monitoring. Supervisor runs create pinned context snapshots automatically. Completion hooks deliver results on the parent's next prompt; they do not wake an idle parent. Antigravity ACP is protocol-tested and requires an endpoint that is not installed on this machine.

```text
npm test
npm run package
```

The default suite uses fixture executors. Set `AGENT_LIVE_TESTS=1` before `npm test` to include authenticated CLI smoke tests; these make model requests. `AGENT_LIVE_CODEX_MODEL` and `AGENT_LIVE_CLAUDE_MODEL` can select models for those tests without changing your CLI configuration. Set `AGENT_INSTALL_TESTS=1` to test both installers in temporary host configuration directories. Tests cover routing, permission arguments, result parsing, resume isolation, errors, timeouts, and simultaneous CLI workers. Packaging copies shared runtime files into the plugin; generated copies are gitignored and must be rebuilt after source changes.

The adapters use the documented [Codex non-interactive CLI](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude print mode](https://code.claude.com/docs/en/headless), [OpenCode run](https://opencode.ai/docs/cli/), and [agy headless mode](https://antigravity.google/docs/cli/headless/). Supervisor mode starts one planner process, up to `maxWorkers` worker processes concurrently, one reviewer per patch, and parent verification processes; generic task mode still starts one process per task or resumed turn.
