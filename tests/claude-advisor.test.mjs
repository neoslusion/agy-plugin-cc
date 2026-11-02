import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMain } from '../scripts/agent-runner.mjs';
import { buildClaudeArgs, runTask } from '../scripts/lib/executors/claude.mjs';
import { loadDelegationConfig } from '../scripts/lib/delegation-config.mjs';

const fake = join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');

// Replays a `claude -p --output-format stream-json` session; event shapes recorded from Claude Code 2.1.307.
function fakeClaude(events) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const binary = join(dir, 'claude.mjs');
  writeFileSync(binary, `for await (const chunk of process.stdin);
for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n');`);
  return binary;
}
const init = analytics => ({ type: 'system', subtype: 'init', session_id: 'claude-session', model: 'claude-haiku-5-5', analytics_disabled: analytics });
const advisorCall = { type: 'assistant', session_id: 'claude-session', message: { content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }] } };
const done = { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session', result: 'true', usage: {} };
function writeConfig(config) {
  const cwd = mkdtempSync(join(tmpdir(), 'advisor-config-'));
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify(config));
  return cwd;
}

test('a configured advisor is passed to the Claude CLI', () => {
  assert.deepEqual(buildClaudeArgs({ options: { model: 'haiku', advisor: 'opus' } }).slice(-4), ['--model', 'haiku', '--advisor', 'opus']);
  assert.ok(!buildClaudeArgs({ options: {} }).includes('--advisor'));
});

test('a Claude worker reports advisor calls, and warns when the session cannot enable the advisor', async () => {
  const used = await runTask({ prompt: 'q', options: { binary: fakeClaude([init(false), advisorCall, done]), advisor: 'opus' } }, { cwd: tmpdir() });
  assert.equal(used.status, 'completed', used.error);
  assert.equal(used.advisorCalls, 1);
  assert.equal(used.notice, null);
  const off = await runTask({ prompt: 'q', options: { binary: fakeClaude([init(true), done]), advisor: 'opus' } }, { cwd: tmpdir() });
  assert.equal(off.status, 'completed');
  assert.equal(off.advisorCalls, 0);
  assert.match(off.notice, /advisor opus is likely off/);
  const plain = await runTask({ prompt: 'q', options: { binary: fakeClaude([init(true), done]) } }, { cwd: tmpdir() });
  assert.equal(plain.advisorCalls, undefined);
  assert.equal(plain.notice, null);
});

test('advisor configuration is accepted only on Claude CLI routes', () => {
  const cwd = writeConfig({ executors: { claude: { advisor: 'opus' } }, roles: { worker: { executor: 'claude', model: 'haiku', advisor: 'opus' } } });
  assert.equal(loadDelegationConfig(cwd).roles.worker.advisor, 'opus');
  assert.throws(() => loadDelegationConfig(writeConfig({ roles: { worker: { executor: 'opencode', advisor: 'opus' } } })), /roles.worker: advisor requires the claude executor/);
  assert.throws(() => loadDelegationConfig(writeConfig({ roles: { worker: { advisor: 'opus' } } })), /roles.worker: advisor requires the claude executor/);
  assert.throws(() => loadDelegationConfig(writeConfig({ executors: { claude: { integration: 'agent-sdk', advisor: 'opus' } } })), /executors.claude: advisor requires/);
  assert.throws(() => loadDelegationConfig(writeConfig({ roles: { worker: { executor: 'claude', advisor: '' } } })), /advisor must be a nonempty string/);
});

test('a delegated role carries its advisor to the worker and its follow-ups', async () => {
  const cwd = writeConfig({ roles: { worker: { executor: 'claude', model: 'haiku', advisor: 'opus' } } });
  const capture = join(cwd, 'capture.json');
  const out = [];
  const context = { cwd, out: { write: text => out.push(text) }, err: { write: () => {} },
    env: { ...process.env, AGENT_DELEGATION_DATA: cwd, AGENT_SESSION_ID: 'advisor-host', CLAUDE_BINARY: fake, FAKE_EXECUTOR_SCENARIO: '{}', FAKE_EXECUTOR_CAPTURE: capture } };
  assert.equal(await runMain(['delegate', '--role', 'worker', '--wait', '--json', '--', 'hello'], context), 0, out.join(''));
  const first = JSON.parse(out.join(''));
  assert.equal(first.status, 'completed');
  const args = JSON.parse(readFileSync(capture, 'utf8')).args;
  assert.deepEqual(args.slice(args.indexOf('--advisor'), args.indexOf('--advisor') + 2), ['--advisor', 'opus']);
  out.length = 0;
  assert.equal(await runMain(['follow-up', first.taskId, '--wait', '--json', '--', 'again'], context), 0, out.join(''));
  assert.ok(JSON.parse(readFileSync(capture, 'utf8')).args.includes('--advisor'));
});
