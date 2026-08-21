---
description: Run a read-only code review of local git changes through the local agy (Antigravity) CLI
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a read-only code review through the local agy CLI.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return agy's output verbatim to the user.

Execution:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "$ARGUMENTS"
```

Return the command stdout verbatim. Do not paraphrase, summarize, or add commentary. Do not fix any issues mentioned in the review output.

Note: `--background` and `--wait` flags removed. Harness manages background execution via `run_in_background: true` on Bash calls when needed.
