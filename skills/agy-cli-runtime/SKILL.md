---
name: agy-cli-runtime
description: Internal contract for invoking the agy task executor. Use only inside the agy:agy-rescue subagent. Not for direct user invocation.
user-invocable: false
disable-model-invocation: true
---

Internal contract for the agy executor runtime. Scoped exclusively to the `agy:agy-rescue` subagent; it is not a user-facing skill.

## Single-command forwarder

- The only permitted invocation is the `task` subcommand of the companion script:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task <prompt> [flags...]
  ```
- `setup`, `plan`, `review`, `adversarial-review`, `status`, `result`, and `cancel` subcommands are FORBIDDEN here. The rescue subagent is a forwarder, not an orchestrator: its only job is to invoke `task` once and return that stdout unchanged.

## Flags

| Flag | Meaning |
| --- | --- |
| `--resume` | Resume the most recent task/plan conversation for this session (conversation id is stored on the job). |
| `--fresh` | Force a new conversation, ignoring any resume context. |
| `--conversation <id>` | Resume a specific conversation by id (from a previous job's result). |
| `--model <slug>` | Pin a model. Valid slugs come from `agy models` (e.g. `gemini-3.5-flash-medium`, `claude-sonnet-4-6`). Unknown slugs make agy fail loudly with exit 1. |
| `--effort low\|medium\|high` | Reasoning effort. |
| `--agent <name>` | Select an agy agent (list with `agy agents`). |
| `--approve-all` | Opt a single write-capable run into `--dangerously-skip-permissions`. Never used by default; never passed for reviews. Without it, headless runs deny **every** shell command (even read-only) — trusted workspaces only auto-allow built-in file reads/edits. |

Note: `--background` and `--wait` flags removed. Harness manages background execution via `run_in_background` parameter on tool calls.

## Output handling

- The `task` subcommand prints the agent's response verbatim on stdout (foreground mode).
- Permission denials surface as a notice on stderr (the run may still exit 0 with empty output) — pass both through unchanged.
- Return the stdout of the `task` command exactly as-is. If the Bash call fails, return nothing.
