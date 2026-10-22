# Provider integration and shared context

Your installed Codex or Claude Code host remains the parent. The plugin routes bounded work through provider adapters and owns portable handoffs, task events and acceptance. No TypeScript application, UI or additional reasoning harness is required.

`transport` chooses native host delegation or an external runner task. `integration` chooses that external task's interface. A native agent still uses its host's lifecycle; its external integration setting matters when dispatched through the runner or supervisor.

| Executor | Integration | Active-task controls | Structured output |
| --- | --- | --- | --- |
| Codex | `cli` (default) | Hard cancellation | Yes |
| Codex | `app-server` | Steer current turn, interrupt | Yes |
| Claude | `cli` (default) | Hard cancellation | Yes |
| Claude | `agent-sdk` | Queue follow-up input, interrupt | Yes |
| Antigravity | `cli` (default) | Hard cancellation | Yes |
| Antigravity | `acp` | Interrupt | No schema constraint |

These follow [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and the [ACP protocol](https://agentclientprotocol.com/protocol/v1/session-setup). The design adopts T3 Code's adapters, explicit handoffs and completion events without its application architecture. Authenticate each corresponding installed binary/server normally. Credentials and native sessions remain provider-owned; the plugin does not copy tokens or transcripts between providers.

Merge settings like these into `.agent-delegation.json`:

```json
{
  "executors": {
    "codex": { "integration": "app-server", "model": "gpt-6.1-sol" },
    "claude": { "integration": "agent-sdk" },
    "agy": { "integration": "cli" }
  },
  "roles": {
    "planner": { "executor": "codex", "transport": "auto", "purpose": "planner" },
    "executor": { "executor": "claude", "purpose": "executor" },
    "reviewer": { "executor": "codex", "purpose": "reviewer" },
    "monitor": { "executor": "claude", "purpose": "monitor" }
  },
  "supervisor": { "monitorRole": "monitor" }
}
```

Choose model IDs your account supports. Existing configurations remain CLI; rich interfaces are opt-in. `task --executor codex --integration app-server` selects one explicitly. `--agent` overrides are CLI-only. The SDK uses your installed Claude executable and project/user settings. Packaging includes the pinned SDK runtime and license.

ACP uses the separate Google Antigravity ACP server from the [official registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp). On Windows, `acp-setup --check` locates a paired server/helper installation and `acp-setup --install` downloads it when missing. The adapter discovers the default project-local managed runtime automatically; set `AGY_ACP_BINARY` for a custom path. See [ACP setup](antigravity-acp-setup.md). The normal `agy` executable is not treated as ACP. Resume is used only when advertised; selected models must be advertised. This adapter requires `plan` mode for read-only work and `yolo` for explicitly authorized writers; different modes fail clearly. ACP cannot serve schema-constrained supervisor planner/executor/reviewer tasks; use CLI or another structured-output interface for those roles. ACP effort selection and steering are not implemented. Live compatibility remains unverified; the current sandbox cannot launch the installer or tests.

## Portable context

Supervisor runs create context automatically. Every child receives a pinned revision and hash in its prompt. The parent updates context after planning and rejected evidence. Context carries `objective`, `acceptanceCriteria`, `decisions`, `ownership`, `baseCommit`, `plan`, `evidence` and `blockers`. This is a bounded handoff, not the whole parent transcript. Native agents still need explicit parent-provided context.

`delegate` creates a minimal context automatically and pins it for the detached worker. For richer acceptance criteria and ownership, write a UTF-8 JSON file:

```json
{
  "objective": "Implement hello world",
  "acceptanceCriteria": ["node hello.mjs prints Hello, world!"],
  "decisions": ["Use the existing Node runtime"],
  "ownership": { "executor": ["hello.mjs"] },
  "evidence": [],
  "blockers": []
}
```

```text
node scripts/agent-runner.mjs context-create --context-file context.json
node scripts/agent-runner.mjs delegate --session-id PARENT --role executor --context-id CONTEXT_ID --context-revision 1 --prompt-file task.txt --json
node scripts/agent-runner.mjs context-show CONTEXT_ID --context-revision 1
node scripts/agent-runner.mjs context-update CONTEXT_ID --context-file update.json --expected-revision 1
```

Updates are patches with optimistic revision checks. Stale updates fail; old revisions remain immutable and hashes are checked on read. Workers report new evidence to the parent rather than updating context. Context is limited to 128 KiB, and its injected prompt excerpt to 24 Ki characters with explicit truncation. Reference large artifacts in files.

Keep `--cwd` and `AGENT_DELEGATION_DATA` consistent across providers. `follow-up TASK_ID` preserves a native ID for the same provider/interface, or builds a handoff for a new provider/interface. The foreground compatibility command's `--resume` selects a terminal job with the same provider, integration, parent session and optional role. See [terminal workflow](terminal-workflow.md) for dispatch, retries and result states.

## Events and completion delivery

External tasks retain their job records and gain version-1 event records: `taskId`, monotonically increasing `sequence`, `type`, `createdAt`, bounded `data`. Lifecycle, provider session, tool activity, permissions, questions and control receipts share this envelope. Raw token deltas are excluded. Supervisor events include phase changes, context revisions and final acceptance.

```text
node scripts/agent-runner.mjs events TASK_ID --session-id PARENT --after 0
node scripts/agent-runner.mjs events TASK_ID --session-id PARENT --after 5 --wait --timeout-ms 10000
node scripts/agent-runner.mjs notifications --session-id PARENT
node scripts/agent-runner.mjs notifications --session-id PARENT --ack
node scripts/agent-runner.mjs steer TASK_ID --session-id PARENT --message-file correction.txt
node scripts/agent-runner.mjs interrupt TASK_ID --session-id PARENT
```

A wait timeout leaves the task running. A queued control does not prove delivery: inspect `control.completed` for accepted/failed status. Claude queues follow-up input; Codex steers its active turn. `interrupt` is graceful provider interruption, while `cancel` retains process-tree cancellation. CLI tasks reject unsupported controls. Supervisor children retain their internal scope (`supervisor:SUPERVISOR_ID`), while the owning parent can inspect and control them using its own session ID.

`start` exports `AGENT_SESSION_ID`. The packaged `SessionStart` hook also provides direct hosts their parent scope, and populates Claude's environment file when available. Use explicit `--session-id` if the host's tool shell lacks it. Notifications require a nonempty parent scope.

`UserPromptSubmit` injects at most 16 completion, failure, cancellation, question, denied-permission or monitor events from the parent and its supervisor children into that parent's next prompt. Only written event sequences are acknowledged; later events remain pending. Reading without `--ack` is repeatable. Worker hooks are disabled. The host must load and trust plugin hooks; Codex's hook trust is host-controlled. This does not wake an idle parent or reproduce T3's server-side steering. `delegate` manages detached workers; foreground commands can still use host background tools. Questions become blockers; this layer does not supply arbitrary interactive answers or broaden permissions.

## Monitor efficiency

`supervisor.monitorRole` is optional. The deterministic runner checks results, ownership, verification and review. It invokes a read-only monitor once per rejected evidence gate, passes bounded evidence, and records the recommendation for the next attempt. Healthy work does not call a monitor model. The monitor cannot approve a rejected patch, change criteria or start workers. Iteration limits and evidence gates still decide completion. This is failure-triggered advice, not a persistent PR watcher or scheduler.
