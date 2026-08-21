---
description: Run a one-shot task through the local agy (Antigravity) CLI
argument-hint: '[--resume|--fresh] [--model <slug>] [--effort low|medium|high] [--agent <name>] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a single task through the local agy CLI as a tracked job.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is a thin passthrough. Do not rewrite the user's task or add instructions.
- Return the companion command's stdout verbatim.

Execution:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task "$ARGUMENTS"
```

Return the command stdout verbatim. If non-zero exit, report error and stop.

Note: `--background` and `--wait` flags removed. Harness manages background execution via `run_in_background: true` on Bash calls when needed.
