# Terminal task management

The plugin keeps the coding host in charge of the conversation. These commands inspect and recover its external workers; they do not add another reasoning harness.

## Recover an interrupted attempt

```sh
node scripts/agent-runner.mjs doctor --session-id PARENT --json
node scripts/agent-runner.mjs doctor TASK --session-id PARENT --repair
node scripts/agent-runner.mjs follow-up TASK "Finish the remaining work after inspecting the current files" --session-id PARENT
```

Diagnosis is read-only unless `--repair` is supplied for one owned task. A task is recoverable only when the recorded worker and provider processes are both confirmed absent. Timestamps, permission errors, and missing worker identity do not establish a crash. Old records without a worker PID remain unknown. Process presence alone does not prove identity or progress, and doctor never signals processes, removes locks, reruns writes, or restores files.

Repair records the attempt as failed with an interruption reason and emits its terminal event. It preserves its original assignment, context revision, provider conversation and request-ID identity. Retrying that request ID still refers to the original attempt; a follow-up gets a new task ID. Inspect changed files and acceptance evidence before continuing. If the attempt never established a native conversation, use `follow-up TASK --fresh` for an explicit handoff.

Supervisors already have resumable checkpoints. Doctor reports their active children and recommends `run --resume --supervisor-id ID`; it does not turn a supervisor terminal merely because its owning process exited. Resolve interrupted children before resuming. A wait timeout leaves work active and is not evidence that recovery is needed.

## Check providers and configured role models

```sh
node scripts/agent-runner.mjs providers --host claude --json
node scripts/agent-runner.mjs providers --role executor --probe --json
node scripts/agent-runner.mjs providers --executor agy --integration acp --probe --json
```

Without `--probe`, this checks executable discovery and lists configured roles. `--probe` starts the provider's supported metadata interface with a bounded timeout, without submitting an inference prompt or opening a coding task. `probeIntegration` identifies that interface: Codex uses App Server and Claude uses Agent SDK even when a role executes through CLI. This verifies metadata initialization, not the selected route's end-to-end execution. Configured routes sharing one provider/interface reuse a probe within that command. Results are not cached across commands or account changes, and no model is silently substituted.

| Provider | Probe | Remaining uncertainty |
| --- | --- | --- |
| Codex | App Server initialization, `account/read` without forced token refresh, paginated `model/list`, supported reasoning efforts. | An account record and model catalog do not verify that inference is permitted. Alternative providers can report no OpenAI auth requirement without validating their credential chain. |
| Claude | Official Agent SDK initialization, `supportedModels()` and sanitized authentication-source information, with an empty input stream. | Authentication validity and model access remain unknown until an actual task succeeds. |
| Antigravity ACP | Paired executable discovery and ACP v1 initialization. | Login, session modes, advertised account models, and completed tasks remain unverified. |
| Antigravity CLI | Bounded version probe. | CLI startup does not validate authentication or discover account models. |

Codex's `model/list` can return a bundled or cached catalog, so `modelListed` is a catalog check and `modelAccessVerified` remains false. See the [official App Server documentation](https://learn.chatgpt.com/docs/app-server) and [catalog limitations](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). Claude introspection uses the installed, pinned Agent SDK rather than hard-coded model names. Protocol probes never print raw account identities or credentials.

Missing executables, failed probes, missing Codex auth, and unlisted configured models/efforts return a nonzero status with details. Unknown access is reported as unknown. ACP preflight now discovers the same managed runtime as the task adapter, without requiring an environment override or automatically downloading anything.

## Evaluate ordinary prompts

After packaging and installing the plugin, run from a normal terminal:

```sh
npm run package
node scripts/dev/evaluate-orchestration.mjs --host claude --executor codex --case small-auto
node scripts/dev/evaluate-orchestration.mjs --host claude --executor codex
node scripts/dev/evaluate-orchestration.mjs --host codex --config .agent-delegation.json --model YOUR_PARENT_MODEL
```

This development script sends ordinary prompts to the actual installed host binary. It is an evaluation launcher, not the product's agent loop. Claude loads the packaged plugin through `--plugin-dir`; Codex requires the plugin to be installed and enabled already. It creates fresh disposable projects, configures their project instructions, and leaves your project's configuration unchanged. Provide explicit parent/worker models through `--model` and `--config` when needed; it never guesses a replacement model or signs you in. Runs consume normal host usage limits and inherit local host account/settings.

Four cases cover a small edit, two independent assignments in auto mode, the same task in manual mode, and an explicit user instruction to avoid delegation. No prompt instructs the host to invoke a particular plugin command. The evaluation forces external role routes so delegation must produce durable task records rather than a claim in the final response. Native agent selection and idle-parent wakeup need separate host-specific validation.

Each project retains its ordinary prompt, configuration, raw parent transcript, stderr, worker events, artifact-check results and `behavior-report.json`. Acceptance checks are snapshotted before the run; modifying them fails the case. Claimed delegation with no task records, unfinished workers, unexpected delegation in manual/override cases, parent failures and failing artifacts also fail. The auto case expects useful delegation for its independent assignments; a direct implementation is recorded as a behavioral mismatch, not an implementation failure.

Use `--case NAME` to run one case and `--timeout-ms N` for a parent budget up to ten minutes. Parent observation ending or timing out does not cancel its separately tracked workers. The launcher stops starting further cases if workers remain active; inspect them with the recorded parent session and runtime data directory. Disposable projects and transcripts are retained for review rather than deleted automatically.

On 2026-10-04 the new recovery, catalog and evaluation-grading mechanics passed fixture tests. Launching the live evaluation and ACP installation is still blocked by the Windows shell launch failure `CreateProcessAsUserW failed: -1073283067`. No automatic-delegation benchmark or real ACP model run is claimed. Completion delivery still occurs at the next host prompt unless that host provides an idle wakeup integration.
