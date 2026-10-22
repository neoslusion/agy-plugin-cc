---
name: delegate
description: Apply configured planner, advisor, executor, and reviewer roles during coding implementation, debugging, or change review. Use when this project enables automatic orchestration or the user requests delegation.
---

The active coding host owns the requested outcome through integration and verification. This skill uses native host agents and configured provider adapters. The external runner can use CLI, Codex App Server, Claude Agent SDK or an installed Antigravity ACP endpoint.

If acting as a delegated worker, or `AGENT_DELEGATION_WORKER=1` is set, perform the assigned task directly and do not orchestrate.

Resolve `../../scripts/agent-runner.mjs` relative to this SKILL.md directory. Run `node "<runner>" config --cwd "<project>"` once to read the routing configuration. If the project instructions select a different config file, pass `--config "<file>"` on every runner command. Keep the project as the working directory.

`automation.mode: auto` permits delegation when useful; `manual` requires a user request to delegate. A direct request to work alone overrides automatic mode. For a small localized task, work in the parent. For substantial implementation, use the configured executor for a bounded assignment once its scope is understood. Use a planner when uncertainty would materially affect implementation, an advisor for a specific decision or blocker, and a reviewer when independent inspection adds value. Roles are available choices, not mandatory phases.

Use `delegate` for bounded external work while the parent continues orchestration. Use `run` when the task benefits from an explicit supervisor loop with isolated writers and evidence gates, or the user requests it. The supervisor validates owned plan steps, requires typed results and independent review, and centrally integrates accepted patches. Read [cli.md](references/cli.md) for dispatch and supervisor commands. Neither a queued receipt nor a successful worker response establishes acceptance.

The configured orchestrator is the preferred parent host/model. Apply its workflow instructions within the user's task and permissions. A running session cannot be switched by this skill: report a known mismatch without claiming the configured model is active. For initial setup or model selection, read [configuration.md](references/configuration.md).

Before dispatch, resolve the role with `node "<runner>" route --role <name> --host codex|claude --cwd "<project>"`. The result supplies the executor, model options, role contract, and transport. Honor explicit user choices. Do not silently substitute a different model or executor after a failure.

- For `native`, use the host's native agent tool with the returned `nativeAgent` definition. Read [native.md](references/native.md) for host details. If the agent or tool is unavailable, report it; use a CLI override only when consistent with the user's requested route and permissions.
- For `cli`, read [cli.md](references/cli.md) for dispatch, permissions, results, and follow-ups.

Give each worker the objective, necessary context, owned files or subsystem, constraints, and observable acceptance criteria. Workers do not necessarily share the parent's transcript. Reuse a worker for follow-ups on the same assignment; pass a concise handoff when changing harnesses.

`delegate` and supervisor runs pin context revisions automatically. Supply richer acceptance criteria, decisions and ownership with a bounded snapshot and `--context-id` plus `--context-revision`; read [coordination.md](references/coordination.md). Use `follow-up TASK_ID` for a terminal worker's continuation: the same provider/interface reuses its native session; a switch creates a portable handoff. Use a new request ID for each assignment round and keep it stable on retries. Approval is explicit on each dispatch, including follow-ups.

Use `tasks` to inspect external workers and supervisor children, `wait` for a bounded result wait, and `watch` for events without model polling. Native agents remain in the host's task view. A wait timeout leaves work active. Completion hooks deliver parent-scoped events at the next user prompt; they do not wake an idle parent.

When the plugin's `delegation` MCP tools are available (Claude Code), prefer `delegate_task`, `task_follow_up`, `task_status`, `task_wait`, `task_steer`, `task_interrupt` and `task_cancel` over the equivalent runner commands. They use this session's scope and the same task state. Start each returned `wakeCommand` as a background Bash command and end your turn instead of polling; its exit re-invokes you. Inspect full results and actual evidence before accepting success. `steer` and `interrupt` require advertised capabilities and an accepted control receipt. Questions and denied permissions are blockers. Optional `supervisor.monitorRole` advises only after rejected evidence and cannot approve a failed gate.

Parallelize independent assignments up to `automation.maxParallel` total active host-native or CLI workers. Explicit supervisor mode separately enforces `supervisor.maxWorkers`, gives every writer a worktree, and rejects overlapping file ownership. This host-driven bound remains an orchestration instruction rather than a cross-process scheduler. Coordinate shared formatting and project-wide checks in the parent; allow focused worker verification that does not race other writers.

Inspect returned evidence and actual changes. Continue authorized integration, relevant checks, and corrections until the requested acceptance criteria are met. A worker reporting success is not artifact acceptance. Ask only for missing decisions or authorization that blocks progress; keep independent work moving. If a worker fails, inspect the reason and narrow, retry, or reassign within the existing scope. Report unresolved blockers and required unfinished work accurately.
