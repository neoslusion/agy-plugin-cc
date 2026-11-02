# Terminal workflow

Agent Delegation is a terminal-first orchestration plugin for existing coding hosts. Codex or Claude Code remains your interactive orchestrator; configured roles select native agents or external providers. It adopts T3 Code's task IDs, explicit handoffs and observable task lifecycle. It is not a T3 frontend or a replacement for T3's application server.

Install the plugin, run `configure --host codex|claude` in your project, select the orchestrator and role models in `.agent-delegation.json`, then use `start` or open your host normally. In auto mode, prompt normally: the host applies the delegation skill when useful. Small tasks remain in the parent. Manual mode requires an explicit delegation request.

## Dispatch and observe

These commands work from the checkout or a packaged plugin's `scripts/agent-runner.mjs`. Keep the project working directory, data directory and parent session consistent across commands. `start` supplies `AGENT_SESSION_ID`; use `--session-id` when your shell does not receive the host's ID.

```text
node scripts/agent-runner.mjs delegate --session-id demo --executor claude --prompt-file task.md --request-id implement-1 --json
node scripts/agent-runner.mjs tasks --session-id demo
node scripts/agent-runner.mjs tasks TASK_ID --session-id demo --json
node scripts/agent-runner.mjs watch TASK_ID --session-id demo --timeout-ms 10000
node scripts/agent-runner.mjs wait TASK_ID --session-id demo --timeout-ms 60000 --json
```

`delegate` starts a detached worker and returns a receipt immediately. A receipt means the task was queued, not that its assignment succeeded. Use `--role NAME` for the configured model, interface and role contract. Native routes use the host's native agent tool; `--executor` explicitly selects external dispatch. `--integration` can select CLI, Codex App Server, Claude Agent SDK or an installed Antigravity ACP endpoint. Approval is explicit per dispatch; read-only roles suppress write approval.

Every external delegation pins an immutable context snapshot. To supply acceptance criteria, decisions and ownership, use `context-create`, then pass `--context-id ID --context-revision N`. Without one, the runner creates a minimal objective snapshot from the assignment. Give workers enough explicit context: provider protocols do not share your host's transcript.

`--request-id` is a retry key scoped to this workspace and parent session. Retrying the same assignment, route and pinned context returns the existing task, including its final result; it does not launch again. A changed assignment or route requires a new key. Each new delegation round gets a new task ID. Reusing a key with `--wait` only changes how the caller observes the task. Pin a context revision when using retry keys; selecting a later revision changes the request.

`tasks` lists supervisor runs and their owned workers together. It hides other parent sessions unless you explicitly request `--all`. Native host agents remain in the host's own task view. Machine output reports `working`, `waiting_for_children`, or `result_available`, attention flags, event cursors, context revisions and saved results. A terminal supervisor is not ready while an owned child remains active.

`wait` and `watch` use a bounded observation budget, at most 60 seconds per call. A timeout returns an explicit timeout flag and leaves work active. For a dispatch that waits briefly, use `delegate --wait --wait-timeout-ms 10000`; its separate `--timeout-ms` limits executor runtime. `wait` returns exit code 1 for a ready failed/cancelled task, and 0 for a completed task or an observation timeout. Inspect `waitTimedOut` and `status` in JSON.

`watch` reads persisted events without model calls. Omit the ID to watch visible tasks in this parent, including tasks discovered while watching. JSON mode emits newline-delimited event envelopes and a final `watch.end` with cursors and `watchTimedOut`. Resume a single task with `--after N`. Stopping the observer does not stop workers, and watching does not acknowledge completion notifications. A session watch finishes when its current tasks and children are ready; it is not a permanent daemon waiting for future assignments.

In Claude Code the plugin also provides these commands as MCP tools
(`mcp__plugin_agent-delegation_delegation__*`): `delegate_task`, `task_follow_up`, `task_status`,
`task_wait`, `task_steer`, `task_interrupt`, `task_cancel` and `delegation_capabilities`. Tasks are
scoped to the Claude session and share state with the runner, so `tasks` shows them too.
`delegate_task` and `task_follow_up` return a `wakeCommand` (`wait TASK_ID --wake`) that blocks
until the task has a result, needs input or loses its worker. The host runs it as a background Bash
command and ends its turn; the command's exit re-invokes the host, including in `claude -p`. Allow
it with the permission rule `Bash(AGENT_DELEGATION_DATA=*)`. Codex hosts keep the runner commands
and next-prompt hooks.

## Continue or switch providers

```text
node scripts/agent-runner.mjs follow-up TASK_ID --session-id demo --prompt-file correction.md --wait --json
node scripts/agent-runner.mjs follow-up TASK_ID --session-id demo --executor codex --prompt-file handoff.md --json
node scripts/agent-runner.mjs follow-up TASK_ID --session-id demo --role reviewer --fresh --prompt-file review.md --json
```

A follow-up creates a new tracked task linked to its predecessor. The predecessor must be terminal. With the same provider/interface it reuses the native conversation, model options and pinned context revision. Turns within a native conversation are serialized. Write approval is never carried forward; pass it explicitly only when already authorized. A different `--role` resolves that role's configured provider and options.

Changing provider/interface, or using `--fresh`, starts a new native conversation and builds a portable context from the prior snapshot, assignment, outcome, reported changed files, checks and blockers. Models and native session IDs do not cross providers. Explicit `--context-id` replaces the automatic handoff, so include the necessary evidence yourself. Follow-up handoffs are bounded summaries; inspect actual files and checks. An independent review should use a fresh conversation and a complete review assignment.

For an active task, use `steer` or `interrupt` only when its interface advertises that control. A queued request needs a `control.completed` receipt to establish acceptance. `cancel` terminates the tracked process tree. The parent can inspect/control its supervisor's children using its own session scope; workers cannot recursively delegate or control parent tasks.

## Acceptance and limits

Generic delegates work in the supplied directory and do not automatically isolate writers or integrate patches. Coordinate file ownership in the parent. Use `run` when you need the existing supervisor's bounded plan, isolated worktrees, typed results, independent review and checks before central integration. Completing a worker task is not proof that the user's acceptance criteria passed. Configured `supervisor.verifyCommands` are executable project configuration: `run` requires `--approve-all` when they are present. See [security and trust boundaries](security.md).

Completion hooks report parent and owned-child events at the next user prompt; they do not wake an idle session. In Claude Code, run `wait TASK_ID --wake` (returned as `wakeCommand` by the MCP tools) as a background Bash command instead: it returns when the task has a result, needs input, or lost its worker, and the host re-invokes the parent on exit. Codex has no equivalent here, so use bounded waits during active orchestration. The optional monitor remains read-only advice after a rejected evidence gate; event watching never calls a monitor model.

Tasks, events, prompts and native session IDs are local artifacts and may contain project context. Terminal dispatch history is retained to preserve results and retry identities; legacy foreground commands keep their 50-record terminal limit. State is keyed by project path: use the same path across providers. Detached workers have no restart daemon; use `doctor` to diagnose interrupted work and inspect its files before an explicit repair/follow-up. [Task management](task-management.md) also covers provider readiness and ordinary-prompt evaluations. `automation.maxParallel` remains a host instruction, while `run` enforces `supervisor.maxWorkers`.
