import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCodexEvent, createCodexStream, runTask as runCodex } from '../scripts/lib/executors/codex.mjs';
import { applyClaudeEvent, createClaudeStream, runTask as runClaude } from '../scripts/lib/executors/claude.mjs';
import { applyOpencodeEvent, createOpencodeStream, runTask as runOpencode } from '../scripts/lib/executors/opencode.mjs';

const CODEX_SESSION = '019ae4c1-7f2b-7c31-9a4e-2d5c8be3a910';
const CLAUDE_SESSION = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OPENCODE_SESSION = 'ses_2f1c9d4a8ffe7Q3m0lV6yB1xWp';

const fixturePath = name => join(import.meta.dirname, 'fixtures', 'events', `${name}.jsonl`);
const fixture = name => readFileSync(fixturePath(name), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

// Replays a recorded stream through the real adapter, including exit handling.
function replayingBinary(name) {
  const directory = mkdtempSync(join(tmpdir(), `fixture-${name}-`));
  const binary = join(directory, `${name}.mjs`);
  writeFileSync(binary, `import { readFileSync } from 'node:fs';
for await (const chunk of process.stdin);
process.stdout.write(readFileSync(${JSON.stringify(fixturePath(name))}, 'utf8'));`);
  return binary;
}

test('the recorded Codex stream satisfies the CLI adapter contract', () => {
  const stream = createCodexStream();
  const tools = [];
  for (const event of fixture('codex')) applyCodexEvent(stream, event, progress => progress.type === 'tool' && tools.push(progress.name));
  assert.equal(stream.terminal, true);
  assert.deepEqual(stream.result, {
    status: 'completed',
    response: 'Replaced the TODO with input validation.',
    error: null,
    conversationId: CODEX_SESSION,
    usage: { input_tokens: 18432, cached_input_tokens: 16256, output_tokens: 214, reasoning_output_tokens: 96 },
    structuredOutput: null,
    changedFiles: ['src/server.ts'],
  });
  assert.deepEqual(tools, ['reasoning', 'command_execution']);
});

test('the recorded Claude stream satisfies the CLI adapter contract and counts advisor calls', () => {
  const stream = createClaudeStream({ advisor: true });
  const tools = [];
  for (const event of fixture('claude')) applyClaudeEvent(stream, event, { advisor: true, onProgress: progress => progress.type === 'tool' && tools.push(progress.name) });
  assert.equal(stream.terminal, true);
  assert.equal(stream.advisorOff, false);
  assert.deepEqual(stream.result, {
    status: 'completed',
    response: 'Added input validation in src/server.ts.',
    error: null,
    conversationId: CLAUDE_SESSION,
    usage: { input_tokens: 9120, cache_creation_input_tokens: 512, cache_read_input_tokens: 7680, output_tokens: 301 },
    structuredOutput: null,
    changedFiles: [],
    advisorCalls: 1,
  });
  assert.deepEqual(tools, ['advisor', 'Edit']);

  const plain = createClaudeStream();
  for (const event of fixture('claude')) applyClaudeEvent(plain, event);
  assert.equal(plain.result.advisorCalls, undefined, 'advisor reporting stays absent when no advisor was requested');
});

test('the recorded OpenCode stream satisfies the CLI adapter contract', () => {
  const stream = createOpencodeStream();
  const tools = [];
  for (const event of fixture('opencode')) applyOpencodeEvent(stream, event, progress => progress.type === 'tool' && tools.push(progress.name));
  assert.equal(stream.started, true);
  assert.equal(stream.failure, null);
  assert.equal(stream.terminal, undefined, 'OpenCode has no terminal event; a clean exit completes the run');
  assert.equal(stream.text.join('\n'), 'Added input validation in src/server.ts.');
  assert.equal(stream.result.conversationId, OPENCODE_SESSION);
  assert.deepEqual(stream.result.changedFiles, ['src/server.ts']);
  assert.deepEqual(stream.result.usage, { input: 12710, output: 222, reasoning: 64, cacheRead: 11800, cacheWrite: 0, cost: 0 });
  assert.deepEqual(tools, ['read', 'edit']);
});

test('successful fixture runs complete end to end through each CLI adapter', async () => {
  const cwd = tmpdir();
  const codex = await runCodex({ prompt: 'replace the TODO', options: { binary: replayingBinary('codex') } }, { cwd });
  assert.equal(codex.status, 'completed', codex.error);
  assert.equal(codex.exitCode, 0);
  assert.equal(codex.conversationId, CODEX_SESSION);
  assert.deepEqual(codex.changedFiles, ['src/server.ts']);

  const claude = await runClaude({ prompt: 'replace the TODO', options: { binary: replayingBinary('claude'), advisor: 'opus' } }, { cwd });
  assert.equal(claude.status, 'completed', claude.error);
  assert.equal(claude.advisorCalls, 1);
  assert.equal(claude.notice, null);

  const opencode = await runOpencode({ prompt: 'replace the TODO', options: { binary: replayingBinary('opencode') } }, { cwd, env: { ...process.env } });
  assert.equal(opencode.status, 'completed', opencode.error);
  assert.equal(opencode.response, 'Added input validation in src/server.ts.');
  assert.deepEqual(opencode.changedFiles, ['src/server.ts']);
});

test('failure events remain terminal even when the process exits cleanly', () => {
  const codex = createCodexStream();
  applyCodexEvent(codex, { type: 'turn.failed', error: { message: 'sandbox denied the command' } });
  assert.equal(codex.terminal, true);
  assert.equal(codex.result.status, 'failed');
  assert.equal(codex.result.error, 'sandbox denied the command');

  const claude = createClaudeStream();
  applyClaudeEvent(claude, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['usage limit reached'], result: '' });
  assert.equal(claude.terminal, true);
  assert.equal(claude.result.status, 'failed');
  assert.equal(claude.result.error, 'usage limit reached');

  const opencode = createOpencodeStream();
  applyOpencodeEvent(opencode, { type: 'error', error: { type: 'provider.no-route', message: 'Model unavailable' } });
  assert.equal(opencode.failure, 'Model unavailable');
});
