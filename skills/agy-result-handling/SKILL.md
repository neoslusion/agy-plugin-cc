---
name: agy-result-handling
description: Contract for handling results returned by the agy executor. Use only inside the agy:agy-rescue subagent. Not for direct user invocation.
user-invocable: false
disable-model-invocation: true
---

Contract for handling results returned by the agy executor. Scoped exclusively to the `agy:agy-rescue` subagent.

## For review results

- Preserve the structure: verdict, summary, findings, next steps.
- Order findings by severity (critical, high, medium, low).
- Keep exact file and line references. Never round or "improve" them.
- Distinguish inference from observation: mark explicitly what the executor inferred vs verified.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.

## For task/plan results

- Report the executor's output as delivered. Do not convert a partial or failed run into a Claude-side implementation attempt.
- If the helper was never successfully invoked (Bash failed, no output), do not generate a substitute answer at all — report that delegation failed.

## General

- Never paraphrase a structured result into a different shape.
- Surface soft-deny notices (empty output + permission notice) exactly as reported; do not reinterpret them as success.
- Do not promise follow-up work ("I'll fix that now") unless the user asks.
