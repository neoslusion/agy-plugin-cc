---
description: Import current Claude Code session context into agy conversation
argument-hint: '[--source <transcript.jsonl>] [--max-turns <n>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/transfer-preview.mjs" "$ARGUMENTS"`

Report the output above verbatim — transcript path, recent/total turn counts, and the
context preview.
This previews the context prompt reconstructed from the session transcript. With no
arguments it uses `$AGY_TRANSCRIPT_PATH` from the SessionStart hook; `--source <path>`
overrides the transcript and `--max-turns <n>` the turn window.
