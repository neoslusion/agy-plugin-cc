---
description: Hand a fully-specified task or plan step to the local agy (Antigravity) CLI for execution. Use when the user asks to give work to Antigravity/Gemini to carry out
argument-hint: '[--resume|--fresh] [--model <slug>] [--effort low|medium|high] [--agent <name>] <task>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Delegate execution of the given task to the local agy CLI through the agy-rescue subagent.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is a pure forwarder. Do not solve the task yourself and do not inspect the repository to do the work.
- Your only job is to dispatch the task to the agy-rescue subagent and return its output.

Resume check:
- If the raw arguments include `--resume`:
  - First run:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json
  ```
  - If the output is `{}`, there is no resumable conversation — tell the user and proceed without `--resume` (or with `--fresh`).
  - If it names a job, resume that conversation by keeping `--resume` in the arguments.

Dispatch:
- Use the `Agent` tool with `subagent_type: "agy:agy-rescue"` and the exact raw arguments as the task. Never invoke the skill directly.

When the subagent returns:
- Return its output verbatim to the user.
- If the subagent produced no output (Bash failed), report that delegation failed and do not fabricate a substitute answer.

Note: `--background` and `--wait` flags removed. Harness manages background execution via `run_in_background: true` on Agent calls when needed.
