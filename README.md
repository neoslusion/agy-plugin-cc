# gemini-plugin-cc

A Claude Code plugin to delegate tasks to the local Google `gemini` CLI as an executor.
Vault-agnostic and standalone; the Gemini analogue of `openai/codex-plugin-cc`.

## Requirements

- The Google Gemini CLI on PATH: `npm install -g @google/gemini-cli`
- Auth: `GEMINI_API_KEY` in the environment, or a completed `gemini` Google sign-in.

## Install (local dev)

Add this repo as a marketplace, then enable the `gemini` plugin.

## Usage

Invoke the `gemini-dispatch` skill with a task (and an optional context-file path).
It runs the task through the `gemini` CLI and reports the result and any changed files.

## Auth

Wraps the official Google `gemini` CLI, which handles its own authentication. This
plugin performs no OAuth and stores no credentials.