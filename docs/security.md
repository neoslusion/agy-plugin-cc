# Security and trust boundaries

Agent Delegation runs other coding agents on your machine. This page states what runs with your
privileges, what is stored, and which parts of a project are executable configuration. It is a
threat model, not a security guarantee.

## Trust levels

| Component | Trust | What it can do |
| --- | --- | --- |
| Codex or Claude Code host | Trusted | Owns the conversation, integration and final acceptance. |
| `.agent-delegation.json` | **Executable configuration** | Selects executors, models, role instructions and verification commands. Treat it like a build script. |
| Worker agents | Untrusted output | Read and, with approval, write files in the supplied directory or worktree. Their reports are evidence, not instructions. |
| Advisors and reviewers | Untrusted output | Read-only. They can recommend or escalate, but cannot accept work or change acceptance criteria. |
| Provider CLIs and APIs | External | Authenticate themselves. Prompts and code leave the machine under that provider's terms. |

The parent must inspect the actual diff and run the relevant checks. A completed task, an advisor
`APPROVE`, or a reviewer verdict is not proof that the requested behavior is correct.

## Executable configuration

Project configuration is not data. Before running a supervisor in a checkout you did not write,
review `.agent-delegation.json`:

- `supervisor.verifyCommands` is an array of argv arrays executed in worker worktrees and again in
  the parent after integration, with your user privileges.
- `roles.<name>.instructions` is injected into worker prompts.
- `roles.<name>.agent` selects a provider-side agent profile.

`run` refuses to start when `verifyCommands` are configured and `--approve-all` was not passed,
including on `--resume`. `--no-integrate` does not exempt the checks. Passing `--approve-all`
authorizes write-capable workers and the configured commands for that run; it is not inherited by
later runs, follow-ups or dispatches.

Generic `delegate`/`task` calls require `--approve-all` per dispatch for write or tool execution.
Planner, advisor, explorer, monitor and reviewer roles suppress bypass flags even when approval is
supplied, and review subcommands always run read-only.

## Prompt injection

Repository content, issue text, dependency output and worker transcripts are untrusted input. A
worker can be influenced by anything it reads, and an advisor reviews that same material. The
supervisor's ownership checks, patch review and verification gates reduce the blast radius, but they
cannot prove that the behavior a worker implemented is the behavior you wanted. Keep tasks bounded,
review diffs, and do not delegate credentials or private keys.

## Data at rest

Task records, event streams, context snapshots, prompts, patches and raw CLI output are stored
locally under `AGENT_DELEGATION_DATA`, then `CLAUDE_PLUGIN_DATA` or `PLUGIN_DATA`, otherwise the
per-user data directory. They are not encrypted and may contain project code or task text.

- Logs include prompts and provider output. Do not delegate secrets.
- State is keyed by project path. Sharing a data directory shares history between hosts.
- Terminal dispatch history is retained to preserve results and retry identities; legacy history
  keeps the newest 50 terminal records.
- Remove the data directory to delete history. Back it up only as carefully as the source it
  describes.

## Execution surfaces

- **Hooks** (`SessionStart`, `UserPromptSubmit`) run bundled scripts with the host's environment.
- **Advisor MCP server** is a per-task process that exposes one consultation tool and reads that
  task's transcript. It is disabled for workers without an advisor role.
- **Managed ACP install** downloads an official Antigravity archive. Verify the source and review
  `acp-setup --check` output before installing.
- **Packaging** copies `scripts/`, `prompts/` and `schemas/` plus a pinned Claude Agent SDK into the
  plugin cache. The cache is self-contained and loads no packages from the project.

## Provider policy

Each provider controls authentication, data use and whether automation is permitted. The agy
adapter is opt-in: Google's Antigravity FAQ says wrapping agy in third-party coding agents is not
supported under consumer plans, and a forum moderator confirmed that orchestration under a consumer
login can trigger account suspension. Use agy only with a Gemini API key or an Enterprise login.
`providers` reports this as a `policy` warning. Free model tiers may train on submitted data; check
the provider's terms before sending private code.

## Reporting

Report suspected vulnerabilities through the repository's private security advisory channel rather
than a public issue. Include the version, host, executor and a minimal reproduction. Do not include
credentials, proprietary code or full task logs.

## Honest limits

- Isolation is a Git worktree, not an operating-system sandbox. A worker CLI can read anything your
  user can read unless that provider's own sandbox restricts it.
- Verification checks execute whatever the project config specifies; they are not a sandbox either.
- Prompt injection cannot be fully prevented. Bounded assignments and human review are the control.
- Windows process-tree termination, lock recovery and atomic writes are best-effort against crashes
  and abandoned holders.
