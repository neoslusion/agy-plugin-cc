# Changelog

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
