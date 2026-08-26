---
description: Import current Claude Code session context into agy conversation
argument-hint: '[--source <transcript.jsonl>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Import the current Claude Code session transcript into agy, enabling agy to reference previous conversation context.

This mirrors codex's session transfer capability, allowing agy to understand what has been discussed and decided in the Claude session before delegating work.

Raw slash-command arguments:
`$ARGUMENTS`

## How it works

1. Read the current Claude session transcript (JSONL format)
2. Extract recent user/assistant turns
3. Format as context prompt for agy
4. Store for injection into next agy task/plan invocation

## Execution

Preview exactly what context the next agy invocation will receive:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/transfer-preview.mjs" "$ARGUMENTS"
```

- With no arguments, uses `$AGY_TRANSCRIPT_PATH` exported by the SessionStart hook.
- `--source <path>` overrides the transcript; `--max-turns <n>` overrides the turn window.
- Report the transcript path, recent/total turn counts, and the preview verbatim.

The transfer itself stays automatic: task/plan invocations inject this context when `AGY_TRANSCRIPT_PATH` is set.
