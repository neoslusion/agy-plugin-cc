---
description: Execute an implementation plan (docs/superpowers/plans/*.md or inline) step-by-step through the local agy (Antigravity) CLI
argument-hint: '[<plan-file|inline plan text>] [--resume|--fresh]'
disable-model-invocation: true
allowed-tools: Read, Glob, Bash(node:*), Bash(git:*), AskUserQuestion
---

Execute a plan step-by-step through the local agy CLI with conversation resume.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command hands the plan to agy. Do not execute the plan yourself.
- Return the companion command's stdout verbatim.

Plan resolution:
- If `$ARGUMENTS` names an existing plan file, pass it through.
- If `$ARGUMENTS` is empty, run without arguments (the companion picks the newest plan under `docs/superpowers/plans/`). If that yields nothing, tell the user to pass a plan file path.

Execution:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" plan "$ARGUMENTS"
```

Return the command stdout verbatim. If non-zero exit, report error and stop.

Note: `--background` and `--wait` flags removed. Harness manages background execution via `run_in_background: true` on Bash calls when needed.
