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

## Transcript resolution

- By default, uses `$AGY_TRANSCRIPT_PATH` from session environment
- Can override with `--source <path>` argument
- Transcript must be a `.jsonl` file from `.claude/projects/`

## Usage

**Import current session:**
```bash
/agy:transfer
```

**Import specific transcript:**
```bash
/agy:transfer --source ~/.claude/projects/my-project/abc123.jsonl
```

## What gets transferred

- Last 10 conversation turns (configurable)
- User prompts and assistant responses
- Excludes tool calls and internal state

## Limitations

- agy doesn't have native conversation import like codex
- Context is injected as a prompt prefix, not true conversation merge
- Large transcripts are truncated to avoid context overflow

## When to use

- Before handing complex work to agy that requires understanding prior decisions
- When agy needs to know "what we tried before"
- For continuity across multiple agy invocations

The transfer happens automatically for task/plan commands when `AGY_TRANSCRIPT_PATH` is set (via SessionStart hook).

This command explicitly triggers transfer and shows what context will be available.
