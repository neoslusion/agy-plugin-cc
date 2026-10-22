# Project configuration

Install the agent-delegation plugin for the selected host, then run:

```text
node "<runner>" configure --cwd "<project>" --host codex
```

For Claude Code use `--host claude`. This creates `.agent-delegation.json` if absent, adds a managed instruction block to AGENTS.md or CLAUDE.md, and generates native agent definitions for the selected host. Existing instructions and unrelated agents are preserved. Edited generated agents cause a conflict instead of being overwritten. `--dry-run` previews paths without writing. `--config <file>` uses an existing alternative configuration.

The default has a planner, advisor, and reviewer on the selected host, plus an agy executor. Model fields are omitted so each CLI uses its own configured default. Only workers actually selected need to be installed/authenticated. Edit the config to set each model explicitly.

- `orchestrator`: `host` (codex or claude), optional `model`, `effort`, and `instructions`.
- `automation`: `mode` (auto or manual), `maxParallel` (1–16, default 4).
- `defaultExecutor`: agy, codex, or claude.
- `executors`: per-executor defaults for `model`, `effort`, `agent`, `timeoutMs`, and `integration` (`cli`, Codex `app-server`, Claude `agent-sdk`, or agy `acp`).
- `roles`: named entries with `executor`, `transport` (auto/native/cli), `purpose` (planner/advisor/executor/reviewer/explorer/tester/monitor), optional `instructions`, and executor options.
- `supervisor`: `maxIterations` (1–16), the enforced concurrent `maxWorkers` limit (1–16), role names for `plannerRole`/`executorRole`/`reviewerRole`, optional `monitorRole`, and `verifyCommands` as an array of argv arrays.

Purpose defaults to a recognized role name (including plan/advise/implement/review/explore/test aliases), or executor for custom names. Native roles use generated definitions; `agent` overrides are supported only with CLI integration. `timeoutMs` applies to external jobs; native lifecycle and timeout controls belong to the host. Transport and integration are separate: a native route uses the host's tool, while external tasks use the configured interface.

CLI overrides win over role options, which win over executor defaults. Models/efforts must be supported by the chosen harness/account. Roles do not grant new permissions. The planner prepares a plan; the advisor is consulted on demand, not an always-running observer.

Supervisor mode is explicit: `run` owns the plan/fan-out/reviewer/verification loop, creates one detached Git worktree per plan step, enforces non-overlapping owned paths, requires typed worker results, and applies only non-empty in-scope patches that pass per-task evidence gates. It does not copy uncommitted parent files into the worker baseline. Configure runnable checks such as `[["npm", "test"]]`; without checks, reviewer approval and typed results are the available acceptance evidence.

To open the configured orchestrator:

```text
node "<runner>" start --cwd "<project>"
```

This synchronizes native definitions and launches the existing interactive binary with model/effort flags. It does not create a model loop or change global model/permission settings. `start --dry-run` prints the exact binary and argument array. Alternatively, open Codex or Claude normally with the desired model; the project instructions still apply. CLI flags and native profiles do not switch a session already running.

The plugin's skill must be installed and enabled for automatic selection. The project instruction block reinforces discovery. Follow the user's request to work alone or explicitly delegate regardless of automatic defaults. Host/model behavior and policy still determine actual delegation; verify real traces when evaluating it.
