# Supervisor mode

The explicit supervisor owns the next-step loop instead of relying on the host model to remember
when to delegate. It plans, isolates writers, collects typed evidence, reviews patches and
integrates accepted work. The host still owns the conversation and final acceptance.

```sh
node scripts/agent-runner.mjs run --cwd /path/to/project --task-file task.md --approve-all --json
```

The parent checkout must be a committed Git repository. Each worker worktree contains tracked
files from the selected commit, not ignored dependencies, credentials or uncommitted parent files.
Provision the repository before running if the executor needs local dependencies; the supervisor
does not create junctions or copy secrets automatically. Use `--allow-dirty` only when the caller
explicitly accepts that uncommitted parent state is not part of the worker baseline.

## Pipeline

1. The supervisor validates a bounded plan with unique step IDs and explicit file ownership.
2. It creates one detached Git worktree per step and dispatches up to `maxWorkers` tasks
   concurrently.
3. Every worker must return the typed task-result contract. Every non-empty patch receives its own
   configured checks and an independent structured review.
4. Accepted patches are applied centrally and in order.
5. Overlapping ownership, out-of-scope edits, failed evidence or patch conflicts stop integration.
   Failed evidence creates a bounded revision.
6. All configured checks run again after central integration.

`--no-integrate` runs the complete plan/fan-out/review/verification loop without modifying the
parent checkout. `--max-iterations N` bounds revisions and `--max-workers N` is the real concurrent
worker limit. Parallel plan steps must declare non-overlapping owned paths.

The supervisor does not treat a worker response, changed-file hint or reviewer claim as proof
without typed results and the configured checks. Semantic correctness still requires appropriate
acceptance criteria; the supervisor provides evidence gates, not a proof of arbitrary software
behavior. See [security and trust boundaries](security.md) for the executable-configuration model.

## Verification commands

Configure `supervisor.verifyCommands` as an array of argv arrays, for example:

```json
{
  "supervisor": {
    "maxIterations": 2,
    "maxWorkers": 2,
    "verifyCommands": [["npm", "test"], ["npm", "run", "lint"]]
  }
}
```

Every task must return valid structured output, produce a non-empty in-scope patch, pass its
checks and receive reviewer approval before any patch is integrated. All configured checks run
again after central integration.

These commands execute project configuration with your privileges, so `run` requires
`--approve-all` whenever any are configured, including on `--resume`. `--no-integrate` does not
exempt them. Planner and reviewer roles remain read-only.

## Resume and cancel

Supervisor checkpoints are stored with the normal job state:

```sh
node scripts/agent-runner.mjs run --resume --supervisor-id ID --json
node scripts/agent-runner.mjs cancel SUPERVISOR_ID
```

Resume continues an interrupted run without rerunning completed child jobs; resuming a terminal
run returns its record. Cancel marks the run cancelled and terminates verified child process
trees. Logs and prompts can contain task context and are stored locally.

Advisor roles are not used by supervisor runs yet. Generic delegation, task controls and
completion hooks are covered in [terminal workflow](terminal-workflow.md) and
[provider coordination](provider-coordination.md).
