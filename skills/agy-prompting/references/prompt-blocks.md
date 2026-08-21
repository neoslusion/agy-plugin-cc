# Prompt block library

Reusable XML block vocabulary for prompts delegated to the agy headless executor. Assemble blocks in this order: role/task first, context next, policy blocks, output contract last.

## `<task>`

The single job. One sentence, imperative, with exact scope.

```
<task>Implement the caching layer described in docs/caching.md in src/cache.mjs, including unit tests.</task>
```

Bad: "Help me with my app." Good: "Add the `/health` endpoint to `src/server.mjs`, matching the OpenAPI spec in `api/openapi.yaml`, and update `tests/server.test.mjs`."

## `<structured_output_contract>`

The exact machine-parseable output shape, in prose. Used when the result must be consumed programmatically. State field names, types, and requiredness explicitly. No markdown fences, no prose outside the payload.

```
<structured_output_contract>Return exactly one JSON object with fields: "verdict" ("approve" or "needs-attention"), "summary" (string), "findings" (array of {severity, title, body, file, line_start, line_end, confidence, recommendation}), and "next_steps" (array of non-empty strings). Do not include anything outside the JSON object.</structured_output_contract>
```

## `<compact_output_contract>`

For short results: state the exact verbatim line(s) expected.

```
<compact_output_contract>Reply with exactly the word PONG and nothing else.</compact_output_contract>
```

## `<default_follow_through_policy>`

What "done" means and when to stop.

```
<default_follow_through_policy>Work until the implementation plan's current step is complete and its tests pass. Do not start the next step. If a step cannot be completed, stop and report exactly what failed and why.</default_follow_through_policy>
```

## `<completeness_contract>`

The checkable conditions that must hold before reporting success.

```
<completeness_contract>Success requires: (1) the new module is exported, (2) `npm test` passes, (3) no existing test was modified. Report failure if any condition cannot be met.</completeness_contract>
```

## `<verification_loop>`

How to verify before claiming completion. Prefer read-only checks; remember headless runs soft-deny interactive commands.

```
<verification_loop>After each change, run `node --test tests/` and confirm it passes before moving on. If it fails, fix and re-run at most twice, then stop and report the remaining failure.</verification_loop>
```

## `<missing_context_gating>`

What to do with absent context: state the gap, don't guess.

```
<missing_context_gating>If the file or spec referenced in the task does not exist, stop and report that the context is missing. Do not invent the missing details.</missing_context_gating>
```

## `<grounding_rules>`

Ground every claim in the repository.

```
<grounding_rules>Cite exact file paths and line numbers for every claim. Do not assert behavior you have not verified by reading the code.</grounding_rules>
```

## `<citation_rules>`

Stricter variant for review-like output.

```
<citation_rules>Every finding must name the file and line range where the issue occurs. Findings without a verifiable location will be discarded.</citation_rules>
```

## `<action_safety>`

Allowed vs forbidden operations. Be explicit.

```
<action_safety>You may read any file and run read-only git commands. You may not modify files, install packages, or run commands that write outside the repository.</action_safety>
```

## `<tool_persistence_rules>`

Headless-mode tool reality: interactive approvals are auto-denied.

```
<tool_persistence_rules>You cannot be prompted for permission. If a command requires approval it will be denied; prefer read-only commands and file edits inside the workspace, which are auto-allowed.</tool_persistence_rules>
```

## `<research_mode>`

For wide scans: breadth first, then depth on targets found.

```
<research_mode>First map the relevant surface (grep for callers, list files) before analyzing any single file. Report the map, then go deep only on files that are implicated.</research_mode>
```

## `<dig_deeper_nudge>`

For diagnosis prompts: require root cause, not symptom.

```
<dig_deeper_nudge>Do not stop at the first plausible cause. Trace the failure back to the root cause in the code and explain why the symptom follows from it.</dig_deeper_nudge>
```

## `<progress_updates>`

What to emit while working (maps to the stream's phase reporting).

```
<progress_updates>Report each step you start and the files you change as you work, then give a final summary of completed work and changed files.</progress_updates>
```
