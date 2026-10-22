# Native workers

Project setup generates native agent definitions from the same role contracts used by CLI workers. Run `configure --host codex|claude` after changing role configuration, or use `start`, which synchronizes definitions before launching the host. Start a new session to discover changed agents.

For Codex, definitions live in `.codex/agents/delegation-<role>.toml`. Spawn the returned native agent type/name using the installed host's tool schema. Its model and effort settings come from the generated definition; omitted values inherit host defaults. Do not override a configured model merely to reuse the parent's full transcript. Retain the returned agent ID for follow-ups and wait for required work before finishing.

For Claude Code, definitions live in `.claude/agents/delegation-<role>.md`. Use the Agent tool with the returned native agent type. Read-only roles expose Read/Glob/Grep; writing roles inherit the parent's permissions and disable Agent spawning. Retain the host's returned agent ID for follow-ups.

Runtime and administrator policy can override native role settings. In particular, a native read-only sandbox preference may not override the parent's active runtime policy. Treat the role contract as a scope instruction, and use the actual host controls for enforcement. Report substitutions or unavailable models rather than claiming the requested model ran.

`transport: auto` uses native agents when the role executor matches the current host; otherwise it uses that executor's CLI. `native` requires its matching host. `cli` always uses a child CLI process. Neither native transport nor model aliases make a different provider's models available in the host.
