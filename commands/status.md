---
description: Show tracked agy jobs, optionally wait for a specific job to finish
argument-hint: '[<job-id|prefix>] [--all] [--wait] [--timeout-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"`

Return the command output above verbatim. Do not paraphrase or add commentary.

With no job id this is a compact table of this session's jobs; `--all` covers every
session; a job id with `--wait` blocks until the job reaches a terminal state or the
timeout elapses.
