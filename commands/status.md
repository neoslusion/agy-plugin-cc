---
description: Show tracked agy jobs, optionally wait for a specific job to finish
argument-hint: '[<job-id|prefix>] [--all] [--wait] [--timeout-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show the status of tracked agy jobs.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Thin passthrough. Do not paraphrase or add commentary.

Flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- With no job id, this prints a compact table of this session's jobs. `--all` shows every session's jobs. With a job id and `--wait`, it blocks until the job reaches a terminal state (or the timeout elapses).
