# CLI workers

Use the runner path resolved by SKILL.md. Every example also accepts the project's `--config <file>` override.

For an explicit supervisor loop, use:

```text
node "<runner>" run --cwd "<project>" --task-file "<task-file>" --approve-all --json
```

The supervisor validates a plan with unique step IDs and explicit file ownership, creates one isolated Git worktree per step, and runs up to `maxWorkers` workers concurrently. Each worker must return `schemas/supervisor-task-result.schema.json`; each patch is checked and independently reviewed. Accepted patches are applied centrally in order. Use `--no-integrate` for a non-mutating run, `--max-iterations N` to bound revisions, and `--resume --supervisor-id ID` to continue an interrupted run without rerunning completed child jobs. The parent checkout must have a committed Git baseline. `--allow-dirty` is an explicit override and does not copy parent uncommitted files into the worker baseline.

`supervisor.verifyCommands` is an array of argv arrays in `.agent-delegation.json`. A task is not complete merely because a worker or reviewer returned text: typed output must be valid, the patch must be non-empty and within the step's ownership, the worker and reviewer must complete, reviewer approval must be `approve`, and all configured checks must pass before and after integration. Overlapping ownership, out-of-scope edits, and patch conflicts fail closed. `cancel SUPERVISOR_ID` cancels the durable run and all verified child process trees.

Write the assignment to a temporary UTF-8 file with the host's file tool to preserve quotes, multiline text, and shell metacharacters:

```text
node "<runner>" delegate --cwd "<project>" --session-id "<parent-session-id>" --role executor --prompt-file "<task-file>" --request-id "<assignment-round>" --json
```

Use the configured role name, which may differ from `executor`. The runner adds its behavior contract and pins a context snapshot. `delegate --role planner` asks for a plan; the older `plan` subcommand executes an existing plan. A dispatch returns a queued receipt with `taskId`, not completed work. Retrying the same assignment/route/context with the same request ID retrieves that task. A new assignment round needs a new key. Pin an explicit context revision for stable retries.

Use a stable host-qualified session ID such as `codex:<session-id>` or `claude:<session-id>`. If the host exposes no ID, generate one once for the parent conversation and reuse it. `delegate` runs a detached worker; `task` remains the foreground compatibility command and can use host background tools.

```text
node "<runner>" tasks --cwd "<project>" --session-id PARENT
node "<runner>" wait TASK_ID --cwd "<project>" --session-id PARENT --timeout-ms 10000 --json
node "<runner>" watch TASK_ID --cwd "<project>" --session-id PARENT --after N --timeout-ms 10000 --json
```

The shared task view includes supervisors and owned children. Native agents remain tracked by the host. `wait` returns a snapshot with `status`, `ready`, `workState`, `waitTimedOut`, and the full saved `task`. `watch --json` emits event envelopes and a final `watch.end` with cursors. Neither calls a model or consumes hook notifications. Budgets are at most 60 seconds and never cancel work; repeat a bounded wait only when needed. `delegate --wait --wait-timeout-ms N` combines dispatch with observation. Its separate `--timeout-ms` limits executor runtime.

Append `--approve-all` only when the existing user authorization permits the executor's autonomous tool scope. CLI adapters use permission bypass, including sandbox bypass in Codex; Claude SDK uses a bounded tool inventory and permission callbacks. Approval is never inherited from the parent. Without it, Codex uses a read-only sandbox, Claude uses a read-only inventory in plan mode, and agy uses headless permission handling. Planner, advisor, explorer, monitor and reviewer roles suppress bypass even if requested; agy also receives plan mode. A role name alone is not an OS security boundary. Report permission failures; do not broaden permissions to repair a failed task.

Use `review --role reviewer --base <ref>` for a git review with collected context and the bundled review schema. Use `delegate --role reviewer` for other bounded review questions. Optional `--json-schema <file>` requests structured output. Otherwise ask for a concise handoff with outcome, evidence or changed files, checks and results, and blockers.

Read `status`, `error`, `response`, `structuredOutput`, and `conversationId`. A nonzero exit or failed status must be surfaced. Inspect diffs and acceptance checks independently.

For a terminal worker's continuation, use `follow-up TASK_ID --prompt-file FILE`. It creates a linked task and reuses the native conversation, model options and pinned context for the same provider/interface. Native turns are serialized. Pass write approval explicitly if the continuation is authorized. `--executor` or `--integration` changes create a new session with a bounded evidence handoff; models and native IDs never cross providers. A different `--role` uses that role's configured route. Use `--fresh` for an independent review with a complete assignment. Explicit `--context-id` replaces the automatic handoff. Active workers require `steer`, `interrupt` or a bounded wait. Supervisor continuations use `run --resume`, not `follow-up`.

The foreground compatibility command still accepts `--conversation`, `--resume` and `--fresh`. See [coordination.md](coordination.md) for context revisions, notifications and live controls.

`--executor agy|codex|claude` explicitly selects CLI transport, overriding native/auto routing. Changing executor discards the previous executor's model options while retaining the role's responsibility. Model and effort CLI flags override configured defaults.

Use `tasks TASK_ID --json` for full worker or supervisor evidence; `cancel TASK_ID` terminates tracked processes. Keep the project, session ID and data-root environment consistent. `AGENT_DELEGATION_DATA` selects a shared state directory across hosts; otherwise the runner uses the host plugin data directory when available, then the system temporary directory. Terminal dispatch history retains results and retry identities. Generic writers share the supplied directory; coordinate ownership or use supervisor worktrees. Completion hooks deliver on the next prompt, not an idle wakeup.
