import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  extractClaudeContext,
  buildContextPrompt,
  selectContextTurns,
  resolveClaudeSessionPath,
  TRANSCRIPT_PATH_ENV,
} from '../scripts/lib/claude-session-transfer.mjs';

function writeTranscript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'agyctx-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  return file;
}

// Real Claude transcripts nest the payload under `message` ({ role, content })
// and use bare `user`/`assistant` type tags. Fixtures must match that shape or
// they will pass against a parser that cannot read a real session.
function turn(role, content, timestamp) {
  return { type: role, message: { role, content }, timestamp };
}

test('extractClaudeContext parses user/assistant turns in order', () => {
  const file = writeTranscript([
    turn('user', 'Fix the multicore IRQ routing bug', '2026-08-25T10:00:00Z'),
    turn('assistant', 'I will analyze the interrupt routing code', '2026-08-25T10:00:01Z'),
    turn('user', 'Focus on tricore_ir.c line 37', '2026-08-25T10:01:00Z'),
    turn('assistant', 'Found the issue - CPU hardcoded to 0', '2026-08-25T10:01:05Z'),
  ]);

  const ctx = extractClaudeContext(file, { maxTurns: 10 });
  assert.ok(ctx);
  assert.equal(ctx.totalTurns, 4);
  assert.equal(ctx.turns.length, 4);
  assert.deepEqual(ctx.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(ctx.turns[2].content, /tricore_ir\.c line 37/);
});

test('extractClaudeContext caps the window at maxTurns, preferring the user asks', () => {
  const file = writeTranscript([
    turn('user', 'first'),
    turn('assistant', 'second'),
    turn('user', 'third'),
  ]);
  const ctx = extractClaudeContext(file, { maxTurns: 2 });
  assert.equal(ctx.totalTurns, 3);
  // Both user turns beat the short assistant narration between them.
  assert.deepEqual(ctx.turns.map((t) => t.content), ['first', 'third']);
});

test('extractClaudeContext falls back to a plain tail when nothing is substantive', () => {
  const file = writeTranscript([
    turn('assistant', 'a.'),
    turn('assistant', 'b.'),
    turn('assistant', 'c.'),
  ]);
  const ctx = extractClaudeContext(file, { maxTurns: 2 });
  assert.deepEqual(ctx.turns.map((t) => t.content), ['b.', 'c.']);
});

test('extractClaudeContext keeps the user ask when narration floods the window', () => {
  // Tool-heavy shape: one real ask, then a long run of short status lines. A
  // plain tail slice would drop the ask and transfer nothing actionable.
  const entries = [turn('user', 'Fix the IRQ routing bug in tricore_ir.c')];
  for (let i = 0; i < 12; i++) {
    entries.push(turn('assistant', `Now step ${i}.`));
  }
  const ctx = extractClaudeContext(writeTranscript(entries), { maxTurns: 5 });
  const users = ctx.turns.filter((t) => t.role === 'user');
  assert.equal(users.length, 1, 'the user ask must survive extraction');
  assert.match(users[0].content, /IRQ routing bug/);

  const prompt = buildContextPrompt(ctx, 'now write the fix');
  assert.match(prompt, /IRQ routing bug/);
});

test('selectContextTurns prefers substantive turns and preserves order', () => {
  const turns = [
    { role: 'user', content: 'the ask' },
    { role: 'assistant', content: 'short.' },
    { role: 'assistant', content: 'x'.repeat(250) },
    { role: 'assistant', content: 'also short.' },
  ];
  const picked = selectContextTurns(turns, 2);
  assert.deepEqual(picked.map((t) => t.role), ['user', 'assistant']);
  assert.equal(picked[1].content.length, 250, 'the long turn beats the short narration');
});

test('extractClaudeContext accepts the legacy top-level content shape', () => {
  const file = writeTranscript([
    { type: 'user', content: 'legacy user turn' },
    { type: 'assistant', content: 'legacy assistant turn' },
  ]);
  const ctx = extractClaudeContext(file, {});
  assert.equal(ctx.totalTurns, 2);
  assert.deepEqual(ctx.turns.map((t) => t.content), ['legacy user turn', 'legacy assistant turn']);
});

test('extractClaudeContext flattens structured content blocks and skips noise', () => {
  const file = writeTranscript([
    turn('user', [{ type: 'text', text: 'look here' }, { type: 'thinking', thinking: 'secret reasoning chain' }]),
    { type: 'other_event', message: { role: 'user', content: 'should be ignored' } },
    'not json at all',
  ]);
  const ctx = extractClaudeContext(file, {});
  assert.equal(ctx.totalTurns, 1);
  assert.match(ctx.turns[0].content, /look here/);
  assert.match(ctx.turns[0].content, /\[thinking: secret reasoning chain\.\.\.\]/);
});

test('extractClaudeContext drops turns whose blocks carry no transferable text', () => {
  const file = writeTranscript([
    turn('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'huge file dump' }]),
    turn('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    turn('user', 'the only real turn'),
  ]);
  const ctx = extractClaudeContext(file, {});
  assert.equal(ctx.totalTurns, 1);
  assert.equal(ctx.turns[0].content, 'the only real turn');
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
    const file = writeTranscript([turn('user', 'hi')]);
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
