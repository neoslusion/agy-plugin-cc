---
description: Cancel a running or queued agy job
argument-hint: '<job-id|prefix>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Cancel a running or queued agy job.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Thin passthrough. Do not paraphrase or add commentary.

Flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- A job id or unambiguous prefix is required. Only running or queued jobs can be cancelled.
