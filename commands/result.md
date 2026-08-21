---
description: Show the full result of a finished agy job (verdict, findings, next steps)
argument-hint: '<job-id|prefix>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show the full result of a finished agy job.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Thin passthrough. Do not paraphrase or add commentary.

Flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- A job id or unambiguous prefix is required. For reviews, the output preserves the verdict, findings (ordered by severity), and next steps.
