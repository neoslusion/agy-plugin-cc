---
description: Check that the local agy (Antigravity) CLI is installed and authenticated, and toggle the stop-review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Check the agy executor's readiness and configure the stop-review gate.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command only checks readiness and toggles configuration.
- Do not install agy yourself. If it is missing, ask the user.

Flow:
1. Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json "$ARGUMENTS"
```
2. Parse the JSON output. Report the result concisely:
   - `ready: true` → tell the user agy is ready (binary + auth) and the current stop-review-gate state.
   - `ready: false` → tell the user what is missing from the `hint` field.
3. If `binary: false` (agy not installed), use `AskUserQuestion` once to offer:
   - "Show install instructions" → point the user to https://antigravity.google/download (or `npm install -g @google/antigravity-cli` if that is the documented install path) and tell them to run `agy` interactively once to sign in.
   - "Cancel" → stop, do nothing else.
4. Do not print credentials or auth tokens. Never read or handle the API key or token value.

Return the setup command's output unchanged to the user.
