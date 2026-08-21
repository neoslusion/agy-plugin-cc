---
name: agy-prompting
description: Doctrine for writing effective prompts for the agy (Antigravity) headless executor. Use only inside the agy:agy-rescue subagent to shape delegated prompts. Not for direct user invocation.
user-invocable: false
disable-model-invocation: true
---

Doctrine for prompting the agy (Antigravity) headless executor. Scoped exclusively to the `agy:agy-rescue` subagent.

## Principles

- The executor is stateless per run: it has no memory of this conversation. Every prompt must be self-contained.
- Headless runs soft-deny tools that require approval (see `agy-cli-runtime`). Do not design prompts that depend on interactive confirmation.
- The executor reports progress in phases (`starting` → `acting` → `responding` → `verifying` → `done`). Prompts that expect a long multi-step job should state their own success criteria and stopping conditions.
- Model output is free text unless a schema is enforced. For structured results, demand a strict machine-parseable shape in the prompt itself and verify it on the way back.

## Block vocabulary

Compose delegated prompts from the following blocks (see `references/prompt-blocks.md` for the full library):

| Block | Purpose |
| --- | --- |
| `<task>` | The single job to do. One job per prompt. |
| `<structured_output_contract>` | The exact machine-parseable output shape. |
| `<default_follow_through_policy>` | What "done" means; when to stop vs keep going. |
| `<completeness_contract>` | What must be true before reporting success. |
| `<verification_loop>` | How to verify work (tests, commands) before claiming completion. |
| `<missing_context_gating>` | What to do when context is absent: ask/state the gap rather than guess. |
| `<grounding_rules>` | Ground claims in the repository; cite files. |
| `<action_safety>` | Which operations are allowed, which are forbidden. |
| `<progress_updates>` | What to report as it works. |

Recipes and antipatterns live in `references/agy-prompt-recipes.md` and `references/agy-prompt-antipatterns.md`.

## Rules

- One task per prompt. Never bundle a review inside a task prompt.
- Put the output contract last, explicitly, in prose — never rely on unstated formatting assumptions.
- When the delegated prompt references files, give exact paths; do not assume the executor shares Claude's working state.
- Never include credentials, API keys, or private context in a prompt.
