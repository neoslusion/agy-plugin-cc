#!/usr/bin/env node
// Preview the Claude -> agy context prompt that task/plan invocations will
// receive when AGY_TRANSCRIPT_PATH (or --source) points at a session JSONL.
import process from 'node:process';
import { parseArgs } from './lib/args.mjs';
import {
  resolveClaudeSessionPath,
  extractClaudeContext,
  buildContextPrompt,
} from './lib/claude-session-transfer.mjs';

const { opts, positionals } = parseArgs(process.argv.slice(2), {
  extraValue: ['source', 'max-turns'],
});

const source = opts.source ?? positionals.find(Boolean);
const transcriptPath = resolveClaudeSessionPath(process.cwd(), source ? { source } : {});
if (!transcriptPath) {
  console.error(
    'No transcript available. Set AGY_TRANSCRIPT_PATH (the SessionStart hook exports it) or pass --source <session.jsonl>.',
  );
  process.exit(1);
}

const ctx = extractClaudeContext(transcriptPath, {
  maxTurns: Number(opts['max-turns'] ?? 10),
});
if (!ctx || ctx.turns.length === 0) {
  console.error(`Transcript at ${transcriptPath} yielded no usable turns.`);
  process.exit(1);
}

console.log(`transcript: ${transcriptPath}`);
console.log(`turns: ${ctx.turns.length} recent / ${ctx.totalTurns} total`);
console.log('--- context prompt preview ---');
console.log(buildContextPrompt(ctx, '<current task prompt>'));
