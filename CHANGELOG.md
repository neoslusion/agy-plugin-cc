# Changelog

## 0.5.0 (unreleased)

- Add an OpenCode executor (`opencode run --format json`) with session follow-ups, read-only roles on its `plan` agent, step usage and edited-file reporting, and make it the starter and fallback default executor. It cannot fill schema-constrained supervisor roles.
- Add `advisorRole` for any worker: a configured advisor answers the worker's `consult_advisor` MCP tool calls mid-turn and reviews every finished, failed or blocked turn, resuming the worker's session with REVISE guidance within `advisorRounds` and reporting escalations to the parent in `result.advisor`.
- Fix OpenCode workers running in the parent's directory: OpenCode takes its project from `PWD`, which a spawned process inherits unchanged.
- Add an `advisor` option for Claude CLI roles and executors that passes `--advisor <model>` to the worker, report `advisorCalls` in its result, and add a notice when the worker's session disables the feature-flag fetching the advisor needs.
- Require explicit `--approve-all` before a supervisor run executes project-configured `verifyCommands`, and add a security and trust-boundary document covering executable configuration, prompt injection, local state and provider policy.
- Make agy opt-in and report a `policy` warning for it in `providers`: Google does not support orchestrating agy from third-party coding agents under consumer logins.
- Fix the shared lock so concurrent writers stop colliding and a lock left behind by a killed process no longer wedges a task ID forever. The wait now uses a jittered backoff with a larger budget, and an abandoned lock is broken only once its recorded holder is confirmed gone and the file identity still matches, so a live holder is never locked out of its critical section.
- Give the MCP delegation test enough headroom to assert that a zero-timeout wait returns without blocking while the worker is still running.

- Add a stdio MCP server to the Claude Code plugin (`.mcp.json`, `scripts/mcp-server.mjs`) exposing delegate, follow-up, status, wait, steer, interrupt, cancel and capabilities tools over the existing runner. Delegation results carry a `wakeCommand` built on the new `wait --wake`, which blocks until a result, required input or lost worker so a background host command can re-invoke an idle parent.
- Give ACP readiness probes a 60-second default; the official Antigravity ACP server 1.4.1 takes about 30 seconds to answer `initialize` on Windows.
- Scope runner tasks to `CLAUDE_CODE_SESSION_ID` when no explicit session is set, and export `AGENT_DELEGATION_DATA` from the SessionStart hook so Bash runner commands use the same state root as the hooks and MCP server.

- Add parent-scoped `doctor` diagnostics and explicit interrupted-task repair after confirmed process exit. Preserve context, native sessions and retry identity; keep supervisor checkpoints resumable and never automatically rerun writes.
- Add `providers` readiness reports and opt-in bounded Codex App Server/Claude Agent SDK model discovery plus ACP initialization. Separate catalog presence from model access and discover managed ACP runtimes consistently during preflight.
- Add an ordinary-prompt evaluation launcher for installed Codex/Claude hosts with isolated projects, transcript capture and acceptance/delegation evidence grading. Live behavioral evaluation remains blocked by the Windows shell launcher.

- Add Windows Antigravity ACP runtime discovery and an explicit `acp-setup --check|--install` command using the official registry and paired server/helper archive, with managed adapter discovery and installer tests. The focused 30-test suite passes, including Windows extraction and isolated plugin packaging; actual Google runtime installation remains blocked by the current shell sandbox.

- Refine the plugin into a terminal-first orchestration workflow: asynchronous `delegate`, parent-scoped `tasks`, bounded `wait` and cursor-based `watch`, and tracked `follow-up` with native session reuse or portable provider handoffs.
- Make dispatch retry keys idempotent across concurrent calls, retain their terminal results, serialize follow-up turns, preserve prepared context in queued tasks, and expose owned supervisor children to parent views, controls and completion hooks.

- Add opt-in Codex App Server, Claude Agent SDK and Antigravity ACP adapters with provider-owned native sessions, scoped permissions, capability checks and supported active-task controls. Keep CLI defaults.
- Add immutable context revisions with hashes and stale-update checks, shared supervisor snapshots, durable ordered events, bounded parent-scoped completion hooks and task coordination commands.
- Add optional read-only monitor advice after failed supervisor evidence gates; preserve acceptance criteria and bounded retries without model polling.

- Add explicit supervisor `run` mode with durable checkpoints, planner/worker/reviewer stages, isolated Git worktrees, patch integration, configurable verification evidence gates, bounded revisions, resume, and identity-aware cancellation.
- Complete omp-style supervisor fan-out: validated multi-step plans with unique IDs and non-overlapping file ownership, typed worker results, bounded concurrent worktrees, per-task checks and structured review, ordered multi-patch integration, durable per-task resume, and fan-out cancellation.
- Add automatic orchestration instructions, shared planner/advisor/executor/reviewer/explorer/tester contracts, and native-or-CLI role routing.
- Add project `configure`, inspectable `route`, and interactive `start` commands. Generate Codex and Claude native agents while preserving existing project instructions and edited agents.
- Apply read-only role intent to all CLI adapters and separate configured parent model selection from worker models.
- Retry transient Windows sharing-lock failures when atomically updating concurrent job records.
- Add the `agent-delegation` plugin for Codex and Claude Code, with one shared delegation skill and configurable executor roles.
- Add a host-neutral runner and Codex/Claude CLI adapters alongside agy. Preserve the existing agy commands and installer.
- Scope resume to executor and parent session; support prompt files, normalized structured results, explicit permissions, timeouts, and child-process cancellation.
- Discover jobs from individual records to avoid concurrent index updates losing jobs. Retain active jobs when pruning terminal history.
- Correct the legacy stop-gate loop guard and skip hooks in delegated workers.
- Add adapter, packaging, concurrent-worker, cancellation, opt-in live CLI, and isolated installer tests.

## 0.4.1 (2026-09-09)

- Renamed marketplace and package manifests from `gemini-plugin-cc` to
  `agy-plugin-cc`.
- Fix (broker lifecycle): `spawnBrokerProcess` now invokes `process.execPath`
  directly instead of relying on `node` in PATH. Added `reapStaleBroker` to kill
  hung or orphaned broker processes (`taskkill` on Windows, `SIGTERM` on POSIX)
  before spawning replacements.
- Fix (context transfer): `extractClaudeContext` now parses real Claude Code
  transcript JSONL structures (`message.content`), strips non-transferable tool
  result blocks, and introduces `selectContextTurns` to ensure user instructions
  are not crowded out by assistant narration.
- Commands: Modernized `/agy:cancel`, `/agy:result`, `/agy:status`, and
  `/agy:transfer` to Claude Code's direct execution `!`node ...`` shorthand.
- Cleaned up unused imports and aligned documentation with on-demand preview.

## 0.4.0 (2026-08-26)

- Fix: the broker now runs one agy child per request instead of a single
  flight. Concurrent `Agent(subagent_type: "agy:task")` fan-out no longer
  collides into `-32001 Broker busy` failures, notifications are routed per
  request, and a disconnecting client kills only its own runs.
- Broker accepts `--binary` / honors `AGY_BINARY` (node scripts wrapped with
  the running Node executable), mirroring the executor — enables fully offline
  testing against the `fake-agy` fixture.
- Fix: `agy-task` / `agy-plan-phase` subagents no longer hardcode
  `--approve-all`. Approval follows the standard resolution chain (explicit
  flag > session mode > plugin config > settings > off); fan-out auto-approval
  is now an explicit orchestrator choice instead of an accident of routing.
- Tests: offline broker suite (`tests/broker.test.mjs`) covering concurrent
  fan-out (asserts overlapping execution windows), stream-json notification
  forwarding, failure propagation, and unknown-method errors. Ported the root
  ad-hoc smoke scripts into real suites — `tests/phased-plan.test.mjs`
  (synthesis gates, abort, failed-phase handling) and
  `tests/context-transfer.test.mjs` (turn extraction, prompt building,
  transcript path resolution) — so `npm test` no longer picks up manual
  scripts that need a live broker.
- Docs/agents: repositioned agy as an executor, not a diagnostician.
  `agy-rescue` now routes fully-specified tasks and plan steps for execution
  instead of inviting "stuck / debugging rescue" delegations, returns failure
  output verbatim (with permission hints) instead of empty hands so an
  autonomously fanning-out orchestrator can react, quotes its task argument
  against shell word-splitting, and never self-grants `--approve-all`.
- Fix: `/agy:transfer` shipped as docs-only with no executable step. It now
  runs `scripts/transfer-preview.mjs`: resolves the transcript
  (`AGY_TRANSCRIPT_PATH` or `--source`), extracts recent turns, and prints
  the context prompt preview verbatim. `validate-commands` now accepts
  Agent-tool delegation (`subagent_type`) and any plugin-script invocation
  instead of demanding a literal companion call in every command file.

## 0.3.1 (2026-08-22)

- Fix: permission denials now surface an actionable hint. A failed task whose
  error matches agy's denial wording (`permission check failed`, `soft-denying
  tool confirmation`) prints `hint: ... --approve-all` on stderr; a soft-denied
  "success" (exit 0, empty output) gets the same hint. Runs already launched
  with `--approve-all` are pointed at `--add-dir`/admin policy instead.
- Fix: failure lines report the real agy envelope status (e.g.
  `agy task failed (ERROR): ...`) instead of the misleading wrapper status
  (`agy task failed (completed): ...`).
- Fix: prompting docs no longer claim read-only shell commands are auto-allowed
  in headless mode. Verified against agy 1.1.17: *every* shell command requires
  approval; only built-in file reads/edits inside trusted workspaces bypass the
  gate. Delegated prompts now instruct agy to use file tools instead of shell
  discovery commands.
- Investigated finer-grained alternatives to `--dangerously-skip-permissions`
  on agy 1.1.17 and found them unusable headless on Windows: PreToolUse allow
  hooks fire after the permission gate, `toolPermission=always-proceed` hangs
  print mode, and `proceed-in-sandbox` fails ("context canceled").
  `--approve-all` remains the only working path for shell-capable tasks.
- Fix: `/agy:result` now renders task/plan results for review — verbatim
  response, changed files, phases, conversation id, and error/notice sections —
  instead of dumping the raw executor envelope (usage counters included).
- Universal installer: `node scripts/dev/install.mjs` registers the directory
  marketplace, installs and enables the plugin using names read from
  `.claude-plugin/*.json` (rename-proof), tolerates re-runs, and works on a
  stock Claude Code setup. `--check` is a doctor that reports marketplace
  registration, installed version vs manifest, enablement, and `agy` CLI
  availability without changing anything.
- Approval no longer needs to be typed every time. `task`/`plan` now resolve
  `approveAll` in order: explicit flag > live Claude session mode (the
  SessionStart hook exports `AGY_APPROVE_ALL=1` when the session runs in
  bypassPermissions) > plugin config (`setup --enable-approve-all`, persisted
  per workspace) > Claude settings (`permissions.defaultMode:
  bypassPermissions`, honoring `CLAUDE_CONFIG_DIR`) > off. New
  `--no-approve-all` flag force-denies regardless of inheritance; `/agy:task`
  asks once via AskUserQuestion when nothing decides. `acceptEdits`
  deliberately does not inherit — it only auto-accepts file edits, not shell
  commands.
- Fix: background job launches no longer block the parent process (the
  detached worker's stdio pipes kept the parent alive until the job finished).
- Fix: hook scripts no longer hang on real sessions where stdin never closes
  (TTY); they now time out and force-exit well under the 5s hook budget.
- Fix: the stop-review gate reads Claude Code's `last_assistant_message`
  payload field directly (transcript parsing kept as fallback).
- Verified end-to-end against a real Claude Code session: plugin validation,
  all slash commands, the rescue subagent, and the Stop/SessionEnd hooks.
- Verified cancellation kills the full agy process tree on Windows.

## 0.3.0 (2026-08-07) — Antigravity (agy) rewrite

- **Migrated from the retired `gemini` CLI to the Antigravity CLI (`agy`).**
  The Google `gemini` CLI was retired on 2026-06-18. `agy` is its successor.
- Replaced the planned ACP broker architecture (no `--acp` transport exists on
  `agy`) with a stateless-per-run executor model: one `agy` headless child per
  job, conversation resume via `--conversation <id>`, structured output via
  `--json-schema`.
- Added a multi-executor core (executor registry) so additional agent CLIs
  (e.g. codex) can be added behind the same job store and command surface.
- New command surface: `/agy:setup`, `/agy:task`, `/agy:execute-plan`,
  `/agy:rescue`, `/agy:review`, `/agy:adversarial-review`, `/agy:status`,
  `/agy:result`, `/agy:cancel`.
- Background jobs with status/result/cancel, session-lifecycle hooks, and an
  opt-in fail-open stop-review gate.
- **Deliberate, documented gaps:**
  - No session-transcript import (`/gemini:transfer` equivalent) — ACP's
    `externalAgentConfig/import` has no agy counterpart.
  - Review runs are read-only by design: they never pass
    `--dangerously-skip-permissions`.
  - The stop-review gate defaults to OFF (`setup --enable-review-gate`).

## 0.1.0 (2026-07-27) — Original scaffold

- Bash-based preflight guard and `gemini-dispatch` skill for the retired
  `gemini` CLI. Superseded by 0.3.0.
