# Changelog

## Unreleased

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
