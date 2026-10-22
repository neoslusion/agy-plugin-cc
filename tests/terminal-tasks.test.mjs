import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runMain } from '../scripts/agent-runner.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';
import { listJobs, upsertJob, mutateJob } from '../scripts/lib/state.mjs';
import { createJobRecord } from '../scripts/lib/tracked-jobs.mjs';
import { createSupervisorRecord, saveSupervisor } from '../scripts/lib/supervisor-state.mjs';
import { createTaskContext, reviseTaskContext, readTaskContext } from '../scripts/lib/task-context.mjs';
import { appendTaskEvent, readTaskEvents, pendingNotifications } from '../scripts/lib/task-events.mjs';

const fake = join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');
const runner = join(import.meta.dirname, '..', 'scripts', 'agent-runner.mjs');
function fixture(scenario = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'terminal-delegation-'));
  const env = { ...process.env, AGENT_DELEGATION_DATA: cwd, AGENT_SESSION_ID: 'parent', CODEX_BINARY: fake, CLAUDE_BINARY: fake,
    FAKE_EXECUTOR_SCENARIO: JSON.stringify(scenario), FAKE_EXECUTOR_CAPTURE: join(cwd, 'capture.json') };
  return { cwd, env, root: taskRoot(cwd, env) };
}
async function command(c, args) {
  const output = [], errors = [];
  const code = await runMain(args, { ...c, out: { write: text => output.push(text) }, err: { write: text => errors.push(text) } });
  return { code, text: output.join(''), error: errors.join(''), json: () => JSON.parse(output.join('')) };
}
function completed(c, id, sessionId = 'parent', extra = {}) {
  const job = createJobRecord({ executor: 'claude', kind: 'task', request: 'fixture', workspaceRoot: c.cwd, sessionId, overrides: { id, status: 'completed', ...extra } });
  upsertJob(c.root, job);
  appendTaskEvent(c.root, id, 'task.completed', {});
  return job;
}

test('detached delegation returns a receipt, wait timeout leaves work active, and result is stable', async () => {
  const c = fixture({ delayMs: 500 });
  const receipt = await command(c, ['delegate', '--executor', 'claude', '--json', 'hello']);
  assert.equal(receipt.code, 0, receipt.error);
  const id = receipt.json().taskId;
  assert.equal(receipt.json().created, true);
  const waiting = await command(c, ['wait', id, '--timeout-ms', '0', '--json']);
  assert.equal(waiting.code, 0);
  assert.equal(waiting.json().waitTimedOut, true);
  assert.ok(['queued', 'running'].includes(waiting.json().status));
  const finished = await command(c, ['wait', id, '--timeout-ms', '10000', '--json']);
  assert.equal(finished.code, 0, finished.error);
  assert.equal(finished.json().workState, 'result_available');
  assert.equal(finished.json().task.result.response, 'PONG\n');
  assert.equal(readTaskEvents(c.root, id)[0].type, 'task.queued');
  const again = await command(c, ['wait', id, '--timeout-ms', '0', '--json']);
  assert.deepEqual(again.json().task.result, finished.json().task.result);
});

test('a concurrent retry launches once; changing the assignment under its request ID fails', async () => {
  const c = fixture({ delayMs: 100 });
  const args = ['delegate', '--executor', 'claude', '--request-id', 'round-1', '--json', 'hello'];
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: c.cwd, env: c.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
  const receipts = await Promise.all([invoke(), invoke(), invoke()]);
  assert.equal(new Set(receipts.map(r => r.taskId)).size, 1);
  assert.equal(receipts.filter(r => r.created).length, 1);
  const retry = await command(c, [...args, '--wait', '--wait-timeout-ms', '10000']);
  assert.equal(retry.code, 0, retry.error);
  assert.equal(retry.json().created, false);
  assert.equal(listJobs(c.root).length, 1);
  assert.equal(readTaskEvents(c.root, receipts[0].taskId).filter(event => event.type === 'task.started').length, 1);
  const changed = await command(c, args.map(value => value === 'hello' ? 'different' : value));
  assert.equal(changed.code, 1);
  assert.match(changed.error, /different assignment or route/);
});

test('same-provider follow-up keeps the native session, model and pinned context, without carrying approval', async () => {
  const c = fixture();
  const context = createTaskContext(c.root, { objective: 'original objective', decisions: ['pinned decision'] });
  const first = await command(c, ['delegate', '--executor', 'codex', '--model', 'worker-model', '--context-id', context.id, '--context-revision', '1', '--approve-all', '--wait', '--json', 'hello']);
  assert.equal(first.code, 0, first.error);
  reviseTaskContext(c.root, context.id, { objective: 'new objective', decisions: ['later decision'] }, 1);
  const second = await command(c, ['follow-up', first.json().taskId, '--wait', '--json', 'continue']);
  assert.equal(second.code, 0, second.error);
  const snapshot = second.json(), capture = JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE));
  assert.notEqual(snapshot.taskId, first.json().taskId);
  assert.equal(snapshot.task.previousTaskId, first.json().taskId);
  assert.equal(snapshot.task.conversationId, 'codex-conv');
  assert.ok(capture.args.includes('resume'));
  assert.ok(capture.args.includes('worker-model'));
  assert.ok(!capture.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(snapshot.task.context.revision, 1);
  assert.match(capture.prompt, /pinned decision/);
  assert.doesNotMatch(capture.prompt, /later decision/);
});

test('switching providers creates a portable evidence handoff and uses the target model', async () => {
  const c = fixture();
  writeFileSync(join(c.cwd, '.agent-delegation.json'), JSON.stringify({ executors: { claude: { model: 'target-model' } } }));
  const first = await command(c, ['delegate', '--executor', 'codex', '--model', 'source-model', '--approve-all', '--wait', '--json', 'implement']);
  assert.equal(first.code, 0, first.error);
  mutateJob(c.root, first.json().taskId, job => ({ ...job, result: { ...job.result, changedFiles: ['hello.mjs'], structuredOutput: { checks: ['node hello.mjs passed'], blockers: ['pending review'] } } }));
  const next = await command(c, ['follow-up', first.json().taskId, '--executor', 'claude', '--wait', '--json', 'review changes']);
  assert.equal(next.code, 0, next.error);
  const capture = JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE));
  assert.ok(capture.args.includes('target-model'));
  assert.ok(!capture.args.includes('source-model'));
  assert.ok(!capture.args.includes('--resume'));
  assert.ok(!capture.args.includes('--dangerously-skip-permissions'));
  assert.match(capture.prompt, /hello.mjs/);
  assert.match(capture.prompt, /node hello.mjs passed/);
  assert.match(capture.prompt, /pending review/);
  assert.notEqual(next.json().task.context.id, first.json().task.context.id);
  assert.equal(readTaskContext(c.root, next.json().task.context.id).payload.objective, 'implement');
});

test('read-only roles stay restricted even when delegation explicitly requests approval', async () => {
  const c = fixture();
  writeFileSync(join(c.cwd, '.agent-delegation.json'), JSON.stringify({ roles: { planner: { executor: 'claude', purpose: 'planner' } } }));
  const result = await command(c, ['delegate', '--role', 'planner', '--approve-all', '--wait', '--json', 'plan this']);
  assert.equal(result.code, 0, result.error);
  assert.equal(result.json().task.execution['approve-all'], false);
  const capture = JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE));
  assert.ok(capture.args.includes('Read,Glob,Grep'));
  assert.ok(!capture.args.includes('--dangerously-skip-permissions'));
});

test('follow-ups serialize native turns, while a new configured role selects its own provider', async () => {
  const c = fixture();
  writeFileSync(join(c.cwd, '.agent-delegation.json'), JSON.stringify({ roles: { reviewer: { executor: 'claude', purpose: 'reviewer', model: 'review-model' } } }));
  const first = await command(c, ['delegate', '--executor', 'codex', '--wait', '--json', 'implement']);
  assert.equal(first.code, 0, first.error);
  c.env.FAKE_EXECUTOR_SCENARIO = JSON.stringify({ delayMs: 700 });
  const turn = await command(c, ['follow-up', first.json().taskId, '--json', 'continue']);
  assert.equal(turn.code, 0, turn.error);
  const overlapping = await command(c, ['follow-up', first.json().taskId, '--json', 'another turn']);
  assert.equal(overlapping.code, 1);
  assert.match(overlapping.error, /active turn/);
  assert.equal((await command(c, ['wait', turn.json().taskId, '--timeout-ms', '10000'])).code, 0);
  c.env.FAKE_EXECUTOR_SCENARIO = '{}';
  const review = await command(c, ['follow-up', turn.json().taskId, '--role', 'reviewer', '--wait', '--json', 'independent review']);
  assert.equal(review.code, 0, review.error);
  assert.equal(review.json().task.executor, 'claude');
  assert.equal(review.json().task.model, 'review-model');
  assert.equal(review.json().task.write, false);
});

test('an active detached worker rejects follow-up and can be cancelled by its parent', async () => {
  const c = fixture({ hang: true });
  const receipt = await command(c, ['delegate', '--executor', 'claude', '--json', 'wait']);
  assert.equal(receipt.code, 0, receipt.error);
  const id = receipt.json().taskId;
  const follow = await command(c, ['follow-up', id, '--json', 'too early']);
  assert.equal(follow.code, 1);
  assert.match(follow.error, /Task is active/);
  const started = Date.now();
  while (!existsSync(c.env.FAKE_EXECUTOR_CAPTURE)) {
    if (Date.now() - started > 5000) assert.fail('worker did not start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const cancel = await command(c, ['cancel', id]);
  assert.equal(cancel.code, 0, cancel.error);
  const result = await command(c, ['wait', id, '--timeout-ms', '0', '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.json().status, 'cancelled');
});

test('task view includes owned supervisor children, hides other sessions, and waits for active children', async () => {
  const c = fixture();
  const run = createSupervisorRecord({ cwd: c.cwd, task: 'supervise', config: {}, sessionId: 'parent' });
  run.status = 'completed'; saveSupervisor(c.root, run); appendTaskEvent(c.root, run.id, 'task.completed', {});
  const child = completed(c, 'owned-child', `supervisor:${run.id}`, { supervisorId: run.id, status: 'running' });
  appendTaskEvent(c.root, child.id, 'task.input_required', { questions: ['clarify ownership'] });
  completed(c, 'other-parent', 'other');
  const listing = await command(c, ['tasks', '--json']);
  assert.deepEqual(new Set(listing.json().tasks.map(task => task.taskId)), new Set([run.id, child.id]));
  const wait = await command(c, ['wait', run.id, '--timeout-ms', '0', '--json']);
  assert.equal(wait.json().workState, 'waiting_for_children');
  assert.equal(wait.json().waitTimedOut, true);
  assert.equal((await command(c, ['tasks', 'other-parent', '--json'])).code, 1);
  assert.equal((await command(c, ['cancel', 'other-parent'])).code, 1);
  assert.equal((await command(c, ['tasks', '--all', '--json'])).json().count, 3);
  const notifications = (await command(c, ['notifications'])).json();
  assert.ok(notifications.some(event => event.taskId === child.id && event.type === 'task.input_required'));
  assert.ok(!notifications.some(event => event.taskId === 'other-parent'));
  mutateJob(c.root, child.id, job => ({ ...job, capabilities: { steering: true } }));
  const control = await command(c, ['steer', child.id, 'clarified ownership']);
  assert.equal(control.code, 0, control.error);
  assert.equal(control.json().taskId, child.id);
  mutateJob(c.root, child.id, job => ({ ...job, status: 'completed' }));
  assert.equal((await command(c, ['wait', run.id, '--timeout-ms', '0', '--json'])).json().ready, true);
});

test('watch drains events in bounded batches, resumes its cursor, and does not consume hook notifications', async () => {
  const c = fixture();
  const job = completed(c, 'watched');
  for (let n = 0; n < 260; n++) appendTaskEvent(c.root, job.id, 'task.progress', { name: `progress-${n}` });
  const watching = await command(c, ['watch', job.id, '--json', '--timeout-ms', '10000']);
  assert.equal(watching.code, 0, watching.error);
  const lines = watching.text.trim().split('\n').map(line => JSON.parse(line));
  const events = lines.filter(item => item.type === 'event').map(item => item.event);
  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 261 }, (_, i) => i + 1));
  assert.equal(lines.at(-1).watchTimedOut, false);
  const again = await command(c, ['watch', job.id, '--after', '261', '--json', '--timeout-ms', '0']);
  assert.equal(JSON.parse(again.text).type, 'watch.end');
  assert.equal(pendingNotifications(c.root, listJobs(c.root), 'parent').length, 1);
});

test('watch waits for the terminal event when the terminal record was written first', async () => {
  const c = fixture();
  const job = completed(c, 'race-event');
  mutateJob(c.root, job.id, current => ({ ...current, status: 'failed' }));
  const writer = setTimeout(() => appendTaskEvent(c.root, job.id, 'task.failed', { error: 'late receipt' }), 100);
  try {
    const watching = await command(c, ['watch', job.id, '--json', '--timeout-ms', '3000']);
    assert.match(watching.text, /late receipt/);
    assert.equal(JSON.parse(watching.text.trim().split('\n').at(-1)).watchTimedOut, false);
  } finally { clearTimeout(writer); }
});

test('a session watch discovers tasks launched after the observer starts', async () => {
  const c = fixture();
  const writer = setTimeout(() => completed(c, 'discovered-worker'), 100);
  try {
    const watching = await command(c, ['watch', '--json', '--timeout-ms', '3000']);
    const lines = watching.text.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(lines.some(item => item.type === 'task.discovered' && item.taskId === 'discovered-worker'));
    assert.ok(lines.some(item => item.type === 'event' && item.event.type === 'task.completed'));
    assert.equal(lines.at(-1).watchTimedOut, false);
  } finally { clearTimeout(writer); }
});

test('validation and worker guards fail without launching work', async () => {
  const c = fixture();
  for (const args of [
    ['delegate', '--executor', 'claude', '--wait-timeout-ms', '5', 'hello'],
    ['delegate', '--executor', 'claude', '--wait', '--wait-timeout-ms', '60001', 'hello'],
    ['delegate', '--executor', 'claude', '--context-revision', '1', 'hello'],
    ['watch', '--after', '1'],
  ]) assert.equal((await command(c, args)).code, 1);
  const worker = { ...c, env: { ...c.env, AGENT_DELEGATION_WORKER: '1' } };
  for (const args of [['delegate', 'nested'], ['follow-up', 'id', 'nested'], ['cancel', 'id']]) assert.equal((await command(worker, args)).code, 1);
  assert.equal(listJobs(c.root).length, 0);
});

test('dispatch results retain retry identity beyond the legacy history limit', () => {
  const c = fixture();
  completed(c, 'durable-task', 'parent', { dispatchFingerprint: 'retry-identity', updatedAt: '2000-01-01T00:00:00.000Z' });
  for (let n = 0; n < 55; n++) completed(c, `legacy-${n}`);
  assert.ok(listJobs(c.root).some(job => job.id === 'durable-task'));
  assert.equal(listJobs(c.root).length, 51);
});

test('wait --wake returns when the parent must act, not on a polling budget', async () => {
  const c = fixture();
  const running = (id, extra = {}) => upsertJob(c.root, createJobRecord({ executor: 'claude', kind: 'task', request: 'fixture', workspaceRoot: c.cwd, sessionId: 'parent', overrides: { id, status: 'running', workerPid: process.pid, ...extra } }));
  running('needs-input');
  appendTaskEvent(c.root, 'needs-input', 'task.input_required', { questions: ['which file?'] });
  const asked = await command(c, ['wait', 'needs-input', '--wake', '--json']);
  assert.equal(asked.json().attentionRequired, true);
  assert.equal(asked.json().waitTimedOut, false);
  running('lost-worker', { workerPid: spawnSync(process.execPath, ['-e', '']).pid });
  const lost = await command(c, ['wait', 'lost-worker', '--wake', '--json']);
  assert.equal(lost.json().workerExited, true);
  assert.equal(lost.json().status, 'running');
  running('finishing');
  setTimeout(() => { mutateJob(c.root, 'finishing', job => ({ ...job, status: 'completed' })); appendTaskEvent(c.root, 'finishing', 'task.completed', {}); }, 300);
  const done = await command(c, ['wait', 'finishing', '--wake', '--json']);
  assert.equal(done.code, 0, done.error);
  assert.equal(done.json().workState, 'result_available');
  const conflicting = await command(c, ['wait', 'finishing', '--wake', '--timeout-ms', '10']);
  assert.equal(conflicting.code, 1);
  assert.match(conflicting.error, /omit --timeout-ms/);
});
