---
description: Cancel a running or queued agy job
argument-hint: '<job-id|prefix>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel "$ARGUMENTS"`

Return the command output above verbatim. A job id or unambiguous prefix is required;
only running or queued jobs can be cancelled.
