# Provider compatibility

Agent Delegation talks to four external executors over seven routes. Each route has a different
event format and a different set of capabilities. This page records the contract the adapters rely
on, the fixtures that pin it, and how to refresh them when a provider changes its output.

The fixtures are recorded event streams, not live tests. They prove that a documented stream still
maps to the adapter result. They do not prove authentication, model access or provider policy.

## Route matrix

| Executor / integration | Event surface | Fixture or test | Structured output | Resume | Steering / interrupt | Approvals | Changed files |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `codex` / `cli` | `codex exec --json` NDJSON | `tests/fixtures/events/codex.jsonl` | `--output-schema` | `exec resume <thread>` | no / no | process-level only | `file_change` items |
| `codex` / `app-server` | JSON-RPC over stdio | `tests/provider-adapters.test.mjs` | schema turn input | thread IDs | `turn/steer`, `turn/interrupt` | approval policy | `fileChange` items |
| `claude` / `cli` | `--print --output-format stream-json` NDJSON | `tests/fixtures/events/claude.jsonl` | `--json-schema` | `--resume <session>` | no / no | process-level only | not reported |
| `claude` / `agent-sdk` | Agent SDK messages | `tests/provider-adapters.test.mjs` | `json_schema` output format | SDK session | streaming input / `interrupt()` | SDK permission handling | `Write`/`Edit` inputs |
| `opencode` / `cli` | `opencode run --format json` NDJSON | `tests/fixtures/events/opencode.jsonl` | not supported | `--session <id>` | no / no | process-level only | completed `edit`/`write`/`patch` tools |
| `agy` / `cli` | `stream-json` envelope | `tests/agy-executor.test.mjs`, `tests/fake-agy.test.mjs` | CLI structured response | `--resume` | no / no | process-level only | Git status since baseline |
| `agy` / `acp` | Agent Client Protocol | `tests/provider-adapters.test.mjs` | not supported | session IDs | no / `session/cancel` | ACP permission requests | tool-call locations |

`steering` and `interrupt` above mean controls exercised through the provider protocol while a turn
is active. CLI routes still support cancellation by terminating the worker process; they cannot
inject a new instruction into an in-flight turn. `approvals` means the adapter can answer a
provider permission request; CLI routes either run with a bypass flag or in a read-only mode.

Capabilities are declared in `scripts/lib/executors/capabilities.mjs` and enforced by
`requireCapabilities`. Requesting `--json-schema` on OpenCode or ACP fails before a worker starts.

## Event contracts

### Codex CLI

- `thread.started` supplies `thread_id`; it becomes the conversation ID used by `exec resume`.
- The last `item.completed` with `item.type === "agent_message"` supplies the response.
- `item.completed` with `item.type === "file_change"` appends every `changes[].path`.
- `turn.completed` is the only successful terminal event and carries `usage`.
- `turn.failed` is a terminal failure. Unknown event types and item types are ignored.
- If the process exits without a terminal event, the task fails even with exit code 0.

### Claude CLI

- `system` / `init` supplies `session_id`. When an advisor was requested and the event has
  `analytics_disabled: true`, the result carries a notice that the advisor is likely off.
- `assistant` content blocks report tool progress. `server_tool_use` named `advisor` increments
  `advisorCalls` when an advisor was requested.
- `result` is terminal. `is_error: false` plus `subtype: "success"` completes the task; otherwise
  the task fails with `errors`, `result` or `subtype` as the message. It also supplies the
  response, usage and `structured_output`.
- Claude CLI does not report changed files in its stream; the supervisor uses the worker
  worktree diff instead.
- `--json-schema` output is read from `structured_output`, not parsed from the response text.

### OpenCode CLI

- `step_start` marks that a step actually ran. A clean exit without one is a failure.
- `text` parts are concatenated with newlines to form the response.
- Completed `tool_use` parts report files through `state.metadata.metadata.files[].file`, falling
  back to `state.input.path` or `state.input.filePath` for `edit`, `write` and `patch`.
- `step_finish` tokens and cost are accumulated. Only intermediate steps report this event, so
  usage can undercount the final answer.
- `error` records a failure message.
- There is no terminal event. Success is a clean exit after at least one step with no error event.

### agy CLI

The CLI adapter parses the Antigravity `stream-json` envelope, including phase changes, tool
events, errors and the final result. `tests/agy-executor.test.mjs` covers the parser; the bundled
`tests/fixtures/fake-agy/fake-agy.mjs` covers the companion's end-to-end task path. The ACP route
uses protocol updates rather than this stream.

## Refreshing a fixture

Record from a throwaway repository with a prompt that exercises a tool and a file edit. Keep
stdout as NDJSON and stderr separate.

```sh
# Codex
codex exec --json --skip-git-repo-check - < prompt.txt > tests/fixtures/events/codex.jsonl

# Claude Code
claude --print --output-format stream-json --verbose --disable-slash-commands \
  --permission-mode plan --tools Read,Glob,Grep < prompt.txt > tests/fixtures/events/claude.jsonl

# OpenCode
opencode run --format json --agent plan < prompt.txt > tests/fixtures/events/opencode.jsonl
```

Before committing, replace session IDs, absolute paths, account names and prompt text with
synthetic values. Preserve field names, types and ordering. Then run:

```sh
node --test tests/provider-streams.test.mjs
```

Add a new fixture or assertion when a provider starts emitting a field the adapter should consume.
Do not silently widen a parser to accept malformed lines: `runCli` fails the task on invalid JSON.

The recorded baselines are Codex 0.163, Claude Code 2.1.307, OpenCode 2.1.2 and Antigravity ACP
1.3.0. Treat these as format samples, not minimum supported versions.

## Version smoke checks

The fixture suite checks parsing, not the installed binaries. To check what is actually installed
and configured:

```sh
node scripts/agent-runner.mjs providers --json
node scripts/agent-runner.mjs providers --role executor --probe --json
node scripts/agent-runner.mjs providers --executor agy --integration acp --probe --json
```

Without `--probe`, the command checks executable discovery and lists configured roles. With
`--probe`, it initializes the provider's metadata interface under a bounded timeout without
submitting an inference prompt. Codex uses App Server and Claude uses the Agent SDK for
introspection even when a role executes through the CLI. A successful probe proves protocol
initialization, not that the selected route can complete a task. See
[task management](task-management.md#check-providers-and-configured-role-models) for the limits of
each probe.
