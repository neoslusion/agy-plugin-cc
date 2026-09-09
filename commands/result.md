---
description: Show the full result of a finished agy job (verdict, findings, next steps)
argument-hint: '<job-id|prefix>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Return the command output above verbatim. Do not paraphrase, summarize, or condense it.

Preserve every detail as reported: job id and status, verdict, findings in severity
order, file paths and line numbers, error or parse messages, and next steps. A job id
or unambiguous prefix is required.
