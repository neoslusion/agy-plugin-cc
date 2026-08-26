import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  extractClaudeContext,
  buildContextPrompt,
  resolveClaudeSessionPath,
  TRANSCRIPT_PATH_ENV,
} from '../scripts/lib/claude-session-transfer.mjs';

function writeTranscript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'agyctx-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  return file;
}

test('extractClaudeContext parses user/assistant turns in order', () => {
  const file = writeTranscript([
    { type: 'user_message', content: 'Fix the multicore IRQ routing bug', timestamp: '2026-08-25T10:00:00Z' },
    { type: 'assistant_message', content: 'I will analyze the interrupt routing code', timestamp: '2026-08-25T10:00:01Z' },
    { type: 'user_message', content: 'Focus on tricore_ir.c line 37', timestamp: '2026-08-25T10:01:00Z' },
    { type: 'assistant_message', content: 'Found the issue - CPU hardcoded to 0', timestamp: '2026-08-25T10:01:05Z' },
  ]);

  const ctx = extractClaudeContext(file, { maxTurns: 10 });
  assert.ok(ctx);
  assert.equal(ctx.totalTurns, 4);
  assert.equal(ctx.turns.length, 4);
  assert.deepEqual(ctx.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(ctx.turns[2].content, /tricore_ir\.c line 37/);
});

test('extractClaudeContext keeps only the most recent turns under maxTurns', () => {
  const file = writeTranscript([
    { type: 'user_message', content: 'first' },
    { type: 'assistant_message', content: 'second' },
    { type: 'user_message', content: 'third' },
  ]);
  const ctx = extractClaudeContext(file, { maxTurns: 2 });
  assert.equal(ctx.totalTurns, 3);
  assert.deepEqual(ctx.turns.map((t) => t.content), ['second', 'third']);
});

test('extractClaudeContext flattens structured content blocks and skips noise', () => {
  const file = writeTranscript([
    { type: 'user_message', content: [{ type: 'text', text: 'look here' }, { type: 'thinking', thinking: 'secret reasoning chain' }] },
    { type: 'other_event', content: 'should be ignored' },
    'not json at all',
  ]);
  const ctx = extractClaudeContext(file, {});
  assert.equal(ctx.totalTurns, 1);
  assert.match(ctx.turns[0].content, /look here/);
  assert.match(ctx.turns[0].content, /\[thinking: secret reasoning chain\.\.\.\]/);
});

test('extractClaudeContext returns null for missing files', () => {
  assert.equal(extractClaudeContext(join(tmpdir(), 'does-not-exist.jsonl')), null);
  assert.equal(extractClaudeContext(null), null);
});

test('buildContextPrompt embeds recent turns and the current task', () => {
  const ctx = { turns: [{ role: 'user', content: 'fix the bug' }, { role: 'assistant', content: 'done' }] };
  const prompt = buildContextPrompt(ctx, 'now write tests');
  assert.match(prompt, /Context from Claude Code session/);
  assert.match(prompt, /user: fix the bug/);
  assert.match(prompt, /assistant: done/);
  assert.match(prompt, /## Current task\s*\n\s*now write tests/);
});

test('buildContextPrompt falls back to the bare task when there is no context', () => {
  assert.equal(buildContextPrompt(null, 'just do it'), 'just do it');
  assert.equal(buildContextPrompt({ turns: [] }, 'just do it'), 'just do it');
});

test('resolveClaudeSessionPath honors env, rejects non-jsonl, tolerates missing files', () => {
  const saved = process.env[TRANSCRIPT_PATH_ENV];
  try {
    const file = writeTranscript([{ type: 'user_message', content: 'hi' }]);
    process.env[TRANSCRIPT_PATH_ENV] = file;
    assert.equal(resolveClaudeSessionPath(process.cwd()), file);

    delete process.env[TRANSCRIPT_PATH_ENV];
    assert.equal(resolveClaudeSessionPath(process.cwd()), null);

    process.env[TRANSCRIPT_PATH_ENV] = join(tmpdir(), 'missing.jsonl');
    assert.equal(resolveClaudeSessionPath(process.cwd()), null);

    process.env[TRANSCRIPT_PATH_ENV] = join(tmpdir(), 'notes.txt');
    assert.throws(() => resolveClaudeSessionPath(process.cwd()), /JSONL/);
  } finally {
    if (saved === undefined) delete process.env[TRANSCRIPT_PATH_ENV];
    else process.env[TRANSCRIPT_PATH_ENV] = saved;
  }
});
