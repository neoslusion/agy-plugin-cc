# agy prompt recipes

Assembled prompts for common delegation shapes. Each recipe follows the block order: role/task → context → policy → output contract.

## Diagnosis

```
You are debugging a failure in this repository.
<task>Diagnose why <command> fails with <symptom>.</task>
<dig_deeper_nudge>Do not stop at the first plausible cause. Trace the failure back to the root cause and explain why the symptom follows.</dig_deeper_nudge>
<grounding_rules>Cite exact file paths and line numbers for every claim.</grounding_rules>
<missing_context_gating>If the failing command or referenced file does not exist, say so. Do not invent details.</missing_context_gating>
<verification_loop>Run the failing command once to confirm the reproducer before analyzing. You may run read-only commands; interactive approvals are auto-denied.</verification_loop>
<compact_output_contract>Finish with a single "Root cause:" line, then "Evidence:" lines with file:line references.</compact_output_contract>
```

## Narrow fix

```
<task>Implement the minimal fix for <bug> in <file> as described.</task>
<action_safety>You may edit files inside the workspace. Do not modify unrelated files, install packages, or change tests to make them pass.</action_safety>
<completeness_contract>Success requires the fix to address the stated bug and the existing test suite to still pass.</completeness_contract>
<verification_loop>After the change, run the targeted test file once and confirm it passes. If it fails, fix and re-run at most twice, then stop and report the remaining failure.</verification_loop>
<progress_updates>Report each file you change as you work, then summarize the final diff.</progress_updates>
```

## Root-cause review (read-only)

```
You are a skeptical reviewer.
<task>Identify the root cause of the behavior change described below, in the current code.</task>
<grounding_rules>Every claim must cite file and line. Do not assert behavior you have not read.</grounding_rules>
<action_safety>Read-only. Do not modify anything.</action_safety>
<structured_output_contract>Return exactly one JSON object with fields: "verdict" ("approve" or "needs-attention"), "summary" (string), "findings" (array of {severity, title, body, file, line_start, line_end, confidence, recommendation}), and "next_steps" (array of non-empty strings).</structured_output_contract>
```

## Research / wide scan

```
<task>Map the code paths involved in <feature>, from entry point to side effects.</task>
<research_mode>First map the relevant surface (grep for callers, list files) before analyzing any single file. Report the map, then go deep only on implicated files.</research_mode>
<grounding_rules>Cite exact file paths and line numbers.</grounding_rules>
<compact_output_contract>Finish with a "Call graph:" section of file:line → file:line edges and a "Risks:" bullet list.</compact_output_contract>
```

## Plan execution

```
You are executing an implementation plan inside this repository. Work through the plan step-by-step in order.
<task>Execute the plan below and verify each step.</task>
<default_follow_through_policy>Execute each step completely before moving on. Do not skip steps. If a step cannot be completed, stop and report exactly what failed and why.</default_follow_through_policy>
<verification_loop>After each step, verify with the relevant tests or build commands when available.</verification_loop>
<progress_updates>Report your progress as you work, then a final summary of completed work and changed files.</progress_updates>

<plan>
<PLAN_TEXT placeholder>
</plan>
```

## Prompt patching (rescue)

When a delegated run fails, re-delegate with the gap filled rather than doing the work yourself:

```
The previous delegated run failed/stopped because: <reason from the failed output>.
<task>Retry the original task, addressing exactly the gap above.</task>
<missing_context_gating>Do not proceed until the missing context above is provided or resolved.</missing_context_gating>
<default_follow_through_policy>If this attempt also cannot complete, stop and report why. Do not guess.</default_follow_through_policy>
```

Original task: <original task text>
