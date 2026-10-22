import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { runCommand } from '../scripts/lib/process.mjs';
import {
  msToDuration,
  buildArgs,
  preflight,
  runTask,
  cancelJob,
  extractNotice,
  collectContext,
  isPermissionDenied,
  permissionDeniedHint,
} from '../scripts/lib/executors/agy.mjs';
import { get, list } from '../scripts/lib/executors/registry.mjs';

function fakeChild(pid = 4242) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { stdout, stderr, pid, kill: () => true, killed: false });
  return child;
}

function feed(child, lines) {
  child.stdout.write(lines.join('\n') + '\n');
}

function close(child, code = 0) {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code);
}

function jsonEnvelope(overrides = {}) {
  return {
    conversation_id: 'conv-1',
    status: 'SUCCESS',
    response: 'PONG\n',
    duration_seconds: 1.0,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
    ...overrides,
  };
}

test('msToDuration converts ms to go durations', () => {
  assert.equal(msToDuration(30 * 60 * 1000), '30m');
  assert.equal(msToDuration(90 * 1000), '1m30s');
  assert.equal(msToDuration(500), '1s');
  assert.equal(msToDuration(0), '0s');
});

test('buildArgs: defaults, passthroughs, and print-timeout', () => {
  const args = buildArgs({
    job: { jobClass: 'task' },
    prompt: 'hello',
    options: { model: 'gemini-3.5-flash-medium', effort: 'high', agent: 'coder', conversation: 'conv-9', jsonSchema: '/tmp/s.json', timeoutMs: 90_000 },
  });
  assert.deepEqual(args, [
    '-p', 'hello',
    '--output-format', 'stream-json',
    '--print-timeout', '1m30s',
    '--disable-slash-commands',
    '--model', 'gemini-3.5-flash-medium',
    '--effort', 'high',
    '--agent', 'coder',
    '--conversation', 'conv-9',
    '--json-schema', '/tmp/s.json',
  ]);
});

test('buildArgs: review jobs never receive --dangerously-skip-permissions', () => {
  const review = buildArgs({ job: { jobClass: 'review' }, prompt: 'r', options: { approveAll: true } });
  assert.ok(!review.includes('--dangerously-skip-permissions'));
  const task = buildArgs({ job: { jobClass: 'task' }, prompt: 't', options: { approveAll: true } });
  assert.ok(task.includes('--dangerously-skip-permissions'));
  const taskNoFlag = buildArgs({ job: { jobClass: 'task' }, prompt: 't', options: {} });
  assert.ok(!taskNoFlag.includes('--dangerously-skip-permissions'));
});

test('registry exposes the agy adapter', () => {
  assert.equal(get('agy').id, 'agy');
  assert.equal(get('agy').binary, 'agy');
  assert.throws(() => get('nope'), /unknown executor/);
  assert.deepEqual(list(), [
    { id: 'agy', binary: 'agy', integrations: ['cli', 'acp'] },
    { id: 'codex', binary: 'codex', integrations: ['cli', 'app-server'] },
    { id: 'claude', binary: 'claude', integrations: ['cli', 'agent-sdk'] },
  ]);
});

test('isPermissionDenied covers envelope errors, notices, and responses', () => {
  assert.equal(isPermissionDenied({ error: 'permission check failed for command "pwd; ls": user denied permission to run command' }), true);
  assert.equal(isPermissionDenied({ notice: 'Print mode: soft-denying tool confirmation "RunCommand" at step 3' }), true);
  assert.equal(isPermissionDenied({ response: 'auto-denied: read_file outside workspace' }), true);
  assert.equal(isPermissionDenied({ error: 'invalid model selection' }), false);
  assert.equal(isPermissionDenied({}), false);
});

test('permissionDeniedHint adapts to job class and approval state', () => {
  const err = { error: 'permission check failed for command "pwd"' };
  assert.match(permissionDeniedHint(err, { jobClass: 'task', approveAll: false }), /--approve-all/);
  const approved = permissionDeniedHint(err, { jobClass: 'task', approveAll: true });
  assert.doesNotMatch(approved, /Re-run with --approve-all/);
  assert.match(approved, /--add-dir|admin/);
  assert.match(permissionDeniedHint(err, { jobClass: 'review' }), /read-only by design/);
  assert.equal(permissionDeniedHint({ error: 'boom' }, { jobClass: 'task' }), null);
});

test('preflight reports ready/auth/binary from injected probe', () => {
  const ready = preflight({ probeCommand: () => ({ code: 0, stdout: '', stderr: '' }) });
  assert.equal(ready.ready, true);
  assert.equal(ready.auth, true);
  assert.equal(ready.binary, true);
  const noAuth = preflight({ probeCommand: () => ({ code: 1, stdout: '', stderr: 'authentication required' }) });
  assert.equal(noAuth.ready, false);
  assert.equal(noAuth.auth, false);
  assert.ok(noAuth.hint.includes('sign in'));
});

test('runTask stream-json: parses NDJSON, maps phases, returns envelope fields', async () => {
  const child = fakeChild();
  const phases = [];
  const progress = [];
  const p = runTask(
    { job: { jobClass: 'task' }, prompt: 'x', options: {}, onProgress: (e) => (e.type === 'phase' ? phases.push(e.phase) : progress.push(e)) },
    { spawnFn: () => child, cwd: undefined }
  );
  feed(child, [
    JSON.stringify({ event: 'init', conversation_id: 'c1', init: { permission_mode: 'request-review' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'unknown' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } } } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'hi\n' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'checkpoint' } }),
    JSON.stringify({ event: 'result', result: jsonEnvelope({ conversation_id: 'c1' }) }),
  ]);
  close(child, 0);
  const result = await p;
  assert.equal(result.status, 'completed');
  assert.equal(result.agyStatus, 'SUCCESS');
  assert.equal(result.conversationId, 'c1');
  assert.equal(result.response, 'PONG\n');
  assert.equal(result.usage.total_tokens, 2);
  assert.deepEqual(phases, ['starting', 'acting', 'responding', 'verifying']);
  const tools = progress.filter((e) => e.type === 'tool');
  assert.equal(tools[0].name, 'run_command');
});

test('runTask stream-json: tool error surfaces tool-error progress and tolerates unknown step types', async () => {
  const child = fakeChild();
  const errors = [];
  const p = runTask(
    { job: { jobClass: 'review' }, prompt: 'x', options: {}, onProgress: (e) => e.type === 'tool-error' && errors.push(e) },
    { spawnFn: () => child, cwd: undefined }
  );
  feed(child, [
    JSON.stringify({ event: 'init', conversation_id: 'c', init: {} }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { type: 'TOOL_ERROR', message: 'User denied permission to run command:\necho x' } } },
    }),
    JSON.stringify({ event: 'result', result: jsonEnvelope({ response: '', conversation_id: 'c' }) }),
  ]);
  close(child, 0);
  const result = await p;
  assert.equal(result.status, 'completed');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.includes('denied permission'));
});

test('runTask soft-deny: jetski stderr notice is captured on an empty SUCCESS', async () => {
  const child = fakeChild();
  const p = runTask({ job: { jobClass: 'task' }, prompt: 'run echo', options: {} }, { spawnFn: () => child, cwd: undefined });
  feed(child, [JSON.stringify({ event: 'init', conversation_id: 'c', init: {} }), JSON.stringify({ event: 'result', result: jsonEnvelope({ response: '' }) })]);
  child.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json.\n');
  close(child, 0);
  const result = await p;
  assert.equal(result.status, 'completed');
  assert.equal(result.response, '');
  assert.ok(result.notice.includes('auto-denied'));
  assert.equal(result.conversationId, 'conv-1');
});

test('runTask json mode: single envelope on stdout', async () => {
  const child = fakeChild();
  const p = runTask({ job: { jobClass: 'task' }, prompt: 'x', options: { outputFormat: 'json' } }, { spawnFn: () => child, cwd: undefined });
  child.stdout.write(JSON.stringify(jsonEnvelope()));
  close(child, 0);
  const result = await p;
  assert.equal(result.status, 'completed');
  assert.equal(result.conversationId, 'conv-1');
  assert.equal(result.response, 'PONG\n');
});

test('runTask ERROR envelope maps to failed', async () => {
  const child = fakeChild();
  const p = runTask({ job: { jobClass: 'task' }, prompt: 'x', options: {} }, { spawnFn: () => child, cwd: undefined });
  feed(child, [
    JSON.stringify({ event: 'init', conversation_id: '', init: {} }),
    JSON.stringify({ event: 'result', result: jsonEnvelope({ status: 'ERROR', response: '', error: 'invalid model selection', conversation_id: '' }) }),
  ]);
  close(child, 1);
  const result = await p;
  assert.equal(result.status, 'failed');
  assert.equal(result.agyStatus, 'ERROR');
  assert.ok(result.error.includes('invalid model'));
});

test('runTask changedFiles reports files touched during the run', async () => {
  const dir = makeTempDir('agy-exec-');
  runCommand('git', ['init', '-q'], { cwd: dir });
  runCommand('git', ['config', 'user.name', 'T'], { cwd: dir });
  runCommand('git', ['config', 'user.email', 't@t'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'before\n');
  runCommand('git', ['add', '-A'], { cwd: dir });
  runCommand('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const child = fakeChild();
  const p = runTask({ job: { jobClass: 'task' }, prompt: 'x', options: {} }, { spawnFn: () => child, cwd: dir });
  feed(child, [
    JSON.stringify({ event: 'init', conversation_id: 'c', init: {} }),
    JSON.stringify({ event: 'result', result: jsonEnvelope({ conversation_id: 'c' }) }),
  ]);
  writeFileSync(join(dir, 'b.txt'), 'created during run\n');
  close(child, 0);
  const result = await p;
  assert.deepEqual(result.changedFiles, ['b.txt']);
});

test('collectContext builds promptExtra for review jobs from git diff', () => {
  const dir = makeTempDir('agy-ctx-');
  runCommand('git', ['init', '-q'], { cwd: dir });
  runCommand('git', ['config', 'user.name', 'T'], { cwd: dir });
  runCommand('git', ['config', 'user.email', 't@t'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  runCommand('git', ['add', '-A'], { cwd: dir });
  runCommand('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  const ctx = collectContext({ cwd: dir, jobClass: 'review' });
  assert.ok(ctx.promptExtra.includes('two'));
  assert.deepEqual(ctx.changedFilesHint, ['a.txt']);
  assert.equal(collectContext({ jobClass: 'task' }).promptExtra, null);
});

test('extractNotice only matches soft-deny markers', () => {
  const bad = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
  assert.ok(extractNotice(bad).includes('auto-denied'));
  assert.equal(extractNotice('regular stderr noise'), null);
});

test('cancelJob requires a pid', () => {
  assert.throws(() => cancelJob(), /no pid/);
});
