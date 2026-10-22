import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { createTaskContext, reviseTaskContext, readTaskContext, contextReference, contextPrompt } from '../scripts/lib/task-context.mjs';
import { appendTaskEvent, pendingNotifications, acknowledgeNotifications, readTaskEvents, waitTaskEvents } from '../scripts/lib/task-events.mjs';
import { createJobRecord, runTrackedJob } from '../scripts/lib/tracked-jobs.mjs';
import { upsertJob, readJobFile } from '../scripts/lib/state.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';
import { runMain } from '../scripts/agent-runner.mjs';
import { notificationHook } from '../scripts/delegation-notifications-hook.mjs';

test('context snapshots pin revisions, reject stale edits and detect tampering', () => {
  const root = makeTempDir('context-');
  const first = createTaskContext(root, { objective: 'Implement hello', decisions: ['use node'], ownership: { hello: ['hello.mjs'] } });
  const second = reviseTaskContext(root, first.id, { evidence: ['node hello.mjs passed'] }, first.revision);
  assert.equal(second.revision, 2);
  assert.equal(readTaskContext(root, first.id).hash, second.hash);
  assert.deepEqual(readTaskContext(root, first.id, 1), first);
  assert.match(contextPrompt(root, contextReference(first)), /use node/);
  assert.doesNotMatch(contextPrompt(root, contextReference(first)), /node hello.mjs passed/);
  assert.throws(() => reviseTaskContext(root, first.id, { blockers: [] }, 1), /Stale/);
  assert.throws(() => createTaskContext(root, { objective: 'bad', unexpected: true }), /Unknown/);
  assert.throws(() => readTaskContext(root, '../outside'), /artifact/i);
  const file = join(root, 'contexts', first.id, '2.json');
  const corrupted = JSON.parse(readFileSync(file)); corrupted.payload.objective = 'changed'; writeFileSync(file, JSON.stringify(corrupted));
  assert.throws(() => readTaskContext(root, first.id, 2), /integrity/);
});

test('events remain ordered across independent writers', async () => {
  const root = makeTempDir('events-');
  const url = pathToFileURL(join(import.meta.dirname, '../scripts/lib/task-events.mjs')).href;
  const run = index => new Promise((resolve, reject) => {
    const source = `import {appendTaskEvent} from ${JSON.stringify(url)}; for(let n=0;n<12;n++)appendTaskEvent(process.argv[1],'shared-task','tool.started',{writer:${index},n});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => error += chunk); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([0, 1, 2].map(run));
  const events = readTaskEvents(root, 'shared-task');
  assert.equal(events.length, 36);
  assert.deepEqual(events.map(e => e.sequence), Array.from({ length: 36 }, (_, n) => n + 1));
  assert.equal(readTaskEvents(root, 'shared-task', 34).length, 2);
});

test('wait timeout leaves work active; notification acknowledgment is bounded and parent scoped', async () => {
  const root = makeTempDir('delivery-');
  const job = createJobRecord({ executor: 'codex', kind: 'task', request: 'hello', sessionId: 'parent-a' }); upsertJob(root, job);
  const waited = await waitTaskEvents(root, job.id, 0, 5);
  assert.equal(waited.waitTimedOut, true); assert.equal(readJobFile(root, job.id).status, 'queued');
  appendTaskEvent(root, job.id, 'task.started');
  for (let n = 0; n < 3; n++) appendTaskEvent(root, job.id, 'task.input_required', { questions: [{ text: `Question ${n}` }] });
  assert.equal(pendingNotifications(root, [job], 'parent-b', true).length, 0);
  assert.equal(pendingNotifications(root, [job], 'parent-a', false, 1).length, 1);
  assert.equal(pendingNotifications(root, [job], 'parent-a', true, 1)[0].sequence, 2);
  assert.deepEqual(pendingNotifications(root, [job], 'parent-a', true).map(e => e.sequence), [3, 4]);
  assert.deepEqual(pendingNotifications(root, [job], 'parent-a'), []);
  assert.throws(() => pendingNotifications(root, [job], null), /session/);
});

test('runner context and hook delivery work in the same workspace and do not expose another session', async () => {
  const cwd = makeTempDir('hook-context-'); const env = { AGENT_DELEGATION_DATA: makeTempDir('hook-state-'), AGENT_SESSION_ID: 'parent-a' };
  const root = taskRoot(cwd, env), outputs = [], errors = [];
  const ctx = { cwd, env, out: { write: text => outputs.push(text) }, err: { write: text => errors.push(text) } };
  writeFileSync(join(cwd, 'context.json'), JSON.stringify({ objective: 'hello', acceptanceCriteria: ['prints hello'] }));
  assert.equal(await runMain(['context-create', '--context-file', 'context.json'], ctx), 0, errors.join(''));
  const snapshot = JSON.parse(outputs.pop());
  assert.equal(await runMain(['context-update', snapshot.id, '--context-file', 'context.json', '--expected-revision', '0'], ctx), 1);
  const job = createJobRecord({ executor: 'claude', kind: 'task', request: 'hello', sessionId: 'parent-a', workspaceRoot: cwd, overrides: { context: contextReference(snapshot) } });
  await runTrackedJob({ root, job, run: async () => ({ status: 'completed', response: 'Created hello.mjs', changedFiles: ['hello.mjs'] }) });
  const input = { cwd, session_id: 'different-native-id', hook_event_name: 'UserPromptSubmit' };
  const first = notificationHook(input, { env });
  assert.match(first.hookSpecificOutput.additionalContext, /Created hello.mjs/);
  assert.deepEqual(notificationHook(input, { env: { ...env, AGENT_SESSION_ID: 'parent-b' } }), {});
  assert.deepEqual(notificationHook(input, { env: { ...env, AGENT_DELEGATION_WORKER: '1' } }), {});
  assert.equal(await runMain(['notifications', '--ack'], ctx), 0);
  assert.equal(JSON.parse(outputs.pop()).length, 1);
  assert.deepEqual(notificationHook(input, { env }), {});
  assert.equal(await runMain(['events', job.id, '--session-id', 'parent-b'], ctx), 1);
  assert.equal(await runMain(['context-create', '--context-file', 'context.json'], { ...ctx, env: { ...env, AGENT_DELEGATION_WORKER: '1' } }), 1);
});

test('session hook gives direct hosts a stable scope and escapes Claude shell exports', () => {
  const file = join(makeTempDir('session-env-'), 'exports');
  const output = notificationHook({ cwd: process.cwd(), session_id: "parent'one", hook_event_name: 'SessionStart' }, { env: { CLAUDE_ENV_FILE: file } });
  assert.match(output.hookSpecificOutput.additionalContext, /--session-id/);
  assert.equal(readFileSync(file, 'utf8'), "\nexport AGENT_SESSION_ID='parent'\\''one'\n");
});

test('session hook pins the shell runner to the state root its hooks and MCP server use', () => {
  const file = join(makeTempDir('session-env-'), 'exports');
  notificationHook({ cwd: process.cwd(), session_id: 'parent', hook_event_name: 'SessionStart' }, { env: { CLAUDE_ENV_FILE: file, CLAUDE_PLUGIN_DATA: "C:\\data\\it's" } });
  assert.equal(readFileSync(file, 'utf8'), "\nexport AGENT_SESSION_ID='parent'\nexport AGENT_DELEGATION_DATA='C:\\data\\it'\\''s'\n");
  const pinned = join(makeTempDir('session-env-'), 'exports');
  notificationHook({ cwd: process.cwd(), session_id: 'parent', hook_event_name: 'SessionStart' }, { env: { CLAUDE_ENV_FILE: pinned, CLAUDE_PLUGIN_DATA: 'plugin', AGENT_DELEGATION_DATA: 'explicit', AGENT_SESSION_ID: 'parent' } });
  assert.throws(() => readFileSync(pinned, 'utf8'), { code: 'ENOENT' });
});

test('a completion arriving during hook delivery remains pending', () => {
  const root = makeTempDir('delivery-race-'), job = { id: 'task-race', sessionId: 'parent' };
  appendTaskEvent(root, job.id, 'task.input_required', { questions: ['first'] });
  const delivered = pendingNotifications(root, [job], 'parent');
  appendTaskEvent(root, job.id, 'task.completed', { summary: 'new result' });
  acknowledgeNotifications(root, 'parent', delivered);
  assert.deepEqual(pendingNotifications(root, [job], 'parent').map(e => e.sequence), [2]);
});

test('automatic resume selection never crosses provider integrations', async () => {
  const cwd = makeTempDir('resume-interface-'), env = { AGENT_DELEGATION_DATA: makeTempDir('resume-state-'), AGENT_SESSION_ID: 'parent' };
  const root = taskRoot(cwd, env), output = [], errors = [];
  const ctx = { cwd, env, out: { write: text => output.push(text) }, err: { write: text => errors.push(text) } };
  const job = createJobRecord({ executor: 'codex', kind: 'task', request: 'hello', sessionId: 'parent', workspaceRoot: cwd, overrides: { status: 'completed', integration: 'cli', conversationId: 'cli-thread' } });
  upsertJob(root, job);
  assert.equal(await runMain(['task-resume-candidate', '--executor', 'codex', '--integration', 'app-server'], ctx), 0, errors.join(''));
  assert.deepEqual(JSON.parse(output.pop()), {});
  assert.equal(await runMain(['task-resume-candidate', '--executor', 'codex'], ctx), 0);
  assert.equal(JSON.parse(output.pop()).conversationId, 'cli-thread');
});
