import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { runCodexAppServer } from '../scripts/lib/executors/codex-app-server.mjs';
import { runClaudeAgentSdk } from '../scripts/lib/executors/claude-agent-sdk.mjs';
import { runAntigravityAcp } from '../scripts/lib/executors/antigravity-acp.mjs';
import { executorCapabilities, requireCapabilities } from '../scripts/lib/executors/capabilities.mjs';
import { queueTaskControl } from '../scripts/lib/task-controls.mjs';

const binary = join(import.meta.dirname, 'fixtures/fake-rpc-provider.mjs');
function rpcFixture(scenario = {}) {
  const cwd = makeTempDir('rpc-'); const capture = join(cwd, 'capture.jsonl');
  const env = { ...process.env, RPC_FIXTURE_SCENARIO: JSON.stringify(scenario), RPC_FIXTURE_CAPTURE: capture };
  return { cwd, env, capture, records: () => readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('integration capabilities reject incompatible providers and unsupported output contracts', () => {
  assert.throws(() => executorCapabilities('claude', 'app-server'), /does not support/);
  assert.throws(() => requireCapabilities('agy', { integration: 'acp', jsonSchema: {} }), /schema-constrained/);
  assert.throws(() => requireCapabilities('codex', { integration: 'app-server', agent: 'custom' }), /--agent/);
  assert.equal(executorCapabilities('claude', 'cli').steering, false);
});

test('Codex RPC negotiates, resumes and separates final schema output from commentary', async () => {
  const c = rpcFixture(); const events = [];
  const result = await runCodexAppServer({ prompt: 'hello', job: { jobClass: 'review' }, options: { binary, model: 'fixture-model', conversation: 'saved-thread', approveAll: true, jsonSchema: { type: 'object' }, timeoutMs: 3000 }, onTaskEvent: e => events.push(e) }, c);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.conversationId, 'saved-thread');
  assert.deepEqual(result.structuredOutput, { answer: 'PONG' });
  const records = c.records(); assert.deepEqual(records.slice(0, 3).map(e => e.method), ['initialize', 'initialized', 'thread/resume']);
  assert.equal(records[2].params.sandbox, 'read-only'); assert.equal(records[2].params.approvalPolicy, 'never');
  assert.equal(records[2].params.model, 'fixture-model'); assert.equal(events[0].type, 'session.started');
});

for (const [label, scenario, expected] of [['reader', {}, 'decline'], ['authorized writer', {}, 'accept'], ['foreign thread', { foreign: true }, 'decline']]) test(`Codex approvals remain scoped for ${label}`, async () => {
  const c = rpcFixture({ permission: true, ...scenario });
  const result = await runCodexAppServer({ prompt: 'hello', options: { binary, approveAll: label !== 'reader', timeoutMs: 3000 } }, c);
  assert.equal(result.status, 'completed', result.error); assert.equal(JSON.parse(result.response).decision, expected);
});

for (const scenario of [{ malformed: true }, { initializeError: true }, { hang: true }]) test(`Codex RPC fails closed: ${JSON.stringify(scenario)}`, async () => {
  const c = rpcFixture(scenario);
  const result = await runCodexAppServer({ prompt: 'hello', options: { binary, timeoutMs: scenario.hang ? 400 : 3000 } }, c);
  assert.equal(result.status, 'failed'); assert.match(result.error, /invalid JSON-RPC|initialization failed|timed out/);
});

for (const operation of ['steer', 'interrupt']) test(`Codex live ${operation} reaches its native turn`, async () => {
  const c = rpcFixture({ hang: true }), root = makeTempDir('controls-');
  const job = { id: 'task-fixture', status: 'running', sessionId: 'parent', capabilities: executorCapabilities('codex', 'app-server') };
  const events = [];
  const task = runCodexAppServer({ job, prompt: 'hello', options: { binary, stateRoot: root, timeoutMs: 4000 }, onTaskEvent: e => {
    events.push(e); if (e.type === 'session.started') queueTaskControl(root, job, 'parent', operation, 'corrected assignment');
  } }, c);
  assert.throws(() => queueTaskControl(root, job, 'wrong-parent', operation, 'bad'), /different parent/);
  const result = await task;
  assert.equal(result.status, operation === 'steer' ? 'completed' : 'cancelled', result.error);
  if (operation === 'steer') assert.equal(result.response, 'corrected assignment');
  assert.ok(c.records().some(e => e.method === `turn/${operation}` && e.params.threadId === 'native-session' && (operation !== 'steer' || e.params.expectedTurnId === 'turn-1')));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(events.some(e => e.type === 'control.completed' && e.data.status === 'accepted'));
});

test('ACP uses advertised mode/model and exact permission option IDs', async () => {
  const c = rpcFixture({ permission: true });
  const result = await runAntigravityAcp({ prompt: 'hello', job: { jobClass: 'review' }, options: { binary, approveAll: true, model: 'fixture-model', conversation: 'saved-acp', timeoutMs: 3000 } }, c);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.conversationId, 'saved-acp');
  assert.equal(JSON.parse(result.response).outcome.optionId, 'real-reject-id');
  assert.ok(c.records().some(e => e.method === 'session/set_mode' && e.params.modeId === 'plan'));
  assert.ok(c.records().some(e => e.method === 'session/set_config_option' && e.params.value === 'fixture-model'));
});

test('ACP refuses missing read-only mode and unadvertised model', async () => {
  for (const [scenario, model, expected] of [[{ noModes: true }, undefined, /required plan/], [{}, 'unknown-model', /unavailable/]]) {
    const result = await runAntigravityAcp({ prompt: 'hello', options: { binary, model, timeoutMs: 3000 } }, rpcFixture(scenario));
    assert.equal(result.status, 'failed'); assert.match(result.error, expected);
  }
  await assert.rejects(() => runAntigravityAcp({ prompt: 'hello', options: {} }, { env: {} }), /AGY_ACP_BINARY/);
});

test('ACP writer rejects permissions for another session and supports graceful cancel', async () => {
  const result = await runAntigravityAcp({ prompt: 'hello', options: { binary, approveAll: true, timeoutMs: 3000 } }, rpcFixture({ permission: true, foreign: true }));
  assert.equal(JSON.parse(result.response).outcome.optionId, 'real-reject-id');
  const root = makeTempDir('acp-control-'), job = { id: 'task-acp', status: 'running', sessionId: 'parent', capabilities: executorCapabilities('agy', 'acp') };
  const cancelled = await runAntigravityAcp({ job, prompt: 'hello', options: { binary, approveAll: true, stateRoot: root, timeoutMs: 3000 }, onTaskEvent: e => {
    if (e.type === 'session.started') queueTaskControl(root, job, 'parent', 'interrupt');
  } }, rpcFixture({ hang: true }));
  assert.equal(cancelled.status, 'cancelled', cancelled.error);
});

test('Claude SDK preserves restrictive inventory, schema output and native session', async () => {
  let captured;
  const queryFactory = value => {
    captured = value.options;
    const generator = (async function* () {
      const input = await value.prompt[Symbol.asyncIterator]().next(); assert.equal(input.value.message.content, 'hello');
      const answer = await value.options.canUseTool('AskUserQuestion', { questions: ['choose?'] }); assert.equal(answer.behavior, 'deny');
      const denied = await value.options.canUseTool('Bash', {}); assert.equal(denied.behavior, 'deny');
      yield { type: 'system', subtype: 'init', session_id: 'sdk-session' };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-session', result: 'PONG', structured_output: { answer: 'PONG' } };
    })(); generator.close = () => {}; return generator;
  };
  const events = [];
  const result = await runClaudeAgentSdk({ prompt: 'hello', job: { jobClass: 'review' }, options: { approveAll: true, conversation: 'sdk-session', model: 'fixture-model', jsonSchema: { type: 'object' }, timeoutMs: 3000 }, onTaskEvent: e => events.push(e) }, { queryFactory });
  assert.equal(result.status, 'completed', result.error); assert.deepEqual(result.structuredOutput, { answer: 'PONG' });
  assert.equal(captured.permissionMode, 'plan'); assert.ok(!captured.tools.includes('Bash')); assert.deepEqual(captured.disallowedTools, ['Agent', 'Skill']);
  assert.equal(captured.resume, 'sdk-session'); assert.equal(result.conversationId, 'sdk-session'); assert.ok(events.some(e => e.type === 'task.input_required'));
});

test('Claude queued steering completes the follow-up rather than discarding it at the first result', async () => {
  const root = makeTempDir('sdk-controls-'), job = { id: 'task-sdk', status: 'running', sessionId: 'parent', capabilities: executorCapabilities('claude', 'agent-sdk') };
  let closed = false;
  const queryFactory = value => {
    const generator = (async function* () {
      for await (const input of value.prompt) {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-session' };
        if (input.message.content === 'original') await new Promise(resolve => setTimeout(resolve, 600));
        yield { type: 'result', subtype: 'success', result: input.message.content };
      }
    })(); generator.close = () => { closed = true; }; return generator;
  };
  const result = await runClaudeAgentSdk({ job, prompt: 'original', options: { stateRoot: root, timeoutMs: 4000 }, onTaskEvent: e => {
    if (e.type === 'session.started') queueTaskControl(root, job, 'parent', 'steer', 'correction');
  } }, { queryFactory });
  assert.equal(result.status, 'completed', result.error); assert.equal(result.response, 'correction'); assert.equal(closed, true);
});

test('Claude SDK rejects an exit without a terminal result', async () => {
  const queryFactory = () => { const generator = (async function* () { yield { type: 'system', session_id: 'sdk-session' }; })(); generator.close = () => {}; return generator; };
  const result = await runClaudeAgentSdk({ prompt: 'hello', options: { timeoutMs: 3000 } }, { queryFactory });
  assert.equal(result.status, 'failed'); assert.match(result.error, /without a terminal result/);
});

test('Claude SDK authorizes only the writer inventory and keeps questions blocked', async () => {
  let captured;
  const queryFactory = value => {
    captured = value.options;
    const generator = (async function* () {
      for (const tool of ['Write', 'Edit', 'Bash']) assert.equal((await captured.canUseTool(tool, { file_path: 'hello.mjs' })).behavior, 'allow');
      assert.equal((await captured.canUseTool('Agent', {})).behavior, 'deny');
      assert.equal((await captured.canUseTool('AskUserQuestion', { questions: ['permission?'] })).behavior, 'deny');
      yield { type: 'result', subtype: 'success', result: 'hello' };
    })(); generator.close = () => {}; return generator;
  };
  const result = await runClaudeAgentSdk({ prompt: 'hello', options: { approveAll: true, timeoutMs: 3000 } }, { queryFactory });
  assert.equal(result.status, 'completed', result.error); assert.equal(captured.permissionMode, 'default');
  assert.ok(captured.tools.includes('Write')); assert.ok(!captured.tools.includes('Agent'));
});

test('Claude SDK graceful interruption is a cancelled task', async () => {
  const root = makeTempDir('sdk-interrupt-'), job = { id: 'task-sdk-interrupt', status: 'running', sessionId: 'parent', capabilities: executorCapabilities('claude', 'agent-sdk') };
  let endTurn;
  const queryFactory = () => {
    const generator = (async function* () {
      const ended = new Promise(resolve => { endTurn = resolve; });
      yield { type: 'system', session_id: 'sdk-interrupt' }; await ended;
      yield { type: 'result', subtype: 'success', result: '' };
    })(); generator.interrupt = async () => { endTurn(); }; generator.close = () => {}; return generator;
  };
  const result = await runClaudeAgentSdk({ job, prompt: 'hello', options: { stateRoot: root, timeoutMs: 3000 }, onTaskEvent: e => {
    if (e.type === 'session.started') queueTaskControl(root, job, 'parent', 'interrupt');
  } }, { queryFactory });
  assert.equal(result.status, 'cancelled', result.error);
});
