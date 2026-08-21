# agy prompt antipatterns

Bad → better pairs. These are the most common ways delegated prompts fail with a headless, stateless executor.

## 1. Assuming shared context

Bad: "Fix the bug from earlier."

Better: "Fix the bug described in `docs/known-bugs.md` section 3: the retry loop in `src/client.mjs` never fires on HTTP 429."

Why: each run is stateless; there is no "earlier".

## 2. No stopping condition

Bad: "Improve the code."

Better: "Refactor `src/parser.mjs` so `parseLine` returns `null` on malformed input instead of throwing, and update `tests/parser.test.mjs` accordingly. Stop when the suite passes."

Why: open-ended goals either run forever or stop arbitrarily; `--print-timeout` will cut them off mid-work.

## 3. Output contract implied by formatting

Bad: "Reply in JSON."

Better: a full `<structured_output_contract>` naming every field, type, and requiredness, and forbidding anything outside the payload.

Why: "in JSON" produces markdown fences, extra prose, and missing fields.

## 4. Demanding interactive confirmation

Bad: "Run `rm -rf build/` after I approve."

Better: "Delete the contents of `build/` — you will not be prompted for approval; if the command requires approval it will be auto-denied. Use file edits where allowed instead."

Why: headless runs soft-deny anything that needs approval; the run may succeed with empty output.

## 5. Review disguised as task

Bad: "Check my changes for issues and fix them."

Better: two separate delegations — a read-only review with `<action_safety>Read-only</action_safety>`, then a separate fix task.

Why: mixing modes bypasses the read-only review guarantee and produces untrustworthy verdicts.

## 6. Trusting the model's self-report

Bad: "Tell me when you're done."

Better: "<completeness_contract>Success requires `npm test` to pass — run it yourself before reporting.</completeness_contract>"

Why: a stateless run that cannot verify will claim completion anyway.

## 7. Credentials or private context in the prompt

Bad: prompts that quote tokens, keys, or secrets.

Better: reference environment variables or files instead: "Read the value from `AGY_EXAMPLE_KEY` in the environment."

Why: prompts may be logged in the job log file; never leak secrets into them.

## 8. Multiple jobs in one prompt

Bad: "Fix the parser, then review the auth module, then write a README."

Better: one prompt per job, sequential delegations.

Why: bundling prevents clean status/resume/cancel semantics and pollutes results.
