import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runMain } from '../scripts/agent-runner.mjs';
import { listJobs, resolveStateRoot } from '../scripts/lib/state.mjs';
import { listSupervisors } from '../scripts/lib/supervisor-state.mjs';
import { workspaceSlug } from '../scripts/lib/workspace.mjs';
import { runCommand } from '../scripts/lib/process.mjs';
import { makeTempDir } from '../scripts/lib/fs.mjs';
import { readTaskContext } from '../scripts/lib/task-context.mjs';
import { readTaskEvents, pendingNotifications } from '../scripts/lib/task-events.mjs';
import { runSupervisor } from '../scripts/lib/supervisor.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';

const fake = join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');

function git(cwd, args) {
  const result = runCommand('git', args, { cwd });
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function repository() {
  const cwd = makeTempDir('supervisor repository ');
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Supervisor Test']);
  git(cwd, ['config', 'user.email', 'supervisor@example.com']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, 'README.md'), '# supervisor fixture\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'initial']);
  return cwd;
}

function context(cwd, { scenario = {}, mutation = { file: 'result.txt', content: 'implemented\n' } } = {}) {
  const data = makeTempDir('supervisor-state-');
  const output = [], errors = [];
  const env = {
    ...process.env,
    AGENT_DELEGATION_DATA: data,
    AGENT_SESSION_ID: 'supervisor-test',
    CODEX_BINARY: fake,
    CLAUDE_BINARY: fake,
    FAKE_EXECUTOR_SCENARIO: JSON.stringify(scenario),
    FAKE_EXECUTOR_MUTATION: JSON.stringify(mutation),
    FAKE_EXECUTOR_PARENT_DIR: cwd,
  };
  if (scenario.barrierRequired) env.FAKE_EXECUTOR_BARRIER = makeTempDir('supervisor-barrier-');
  return {
    cwd,
    env,
    out: { write: text => output.push(text) },
    err: { write: text => errors.push(text) },
    output,
    errors,
    root: resolveStateRoot(data, workspaceSlug(cwd)),
  };
}

function config(cwd, extra = {}) {
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify({
    defaultExecutor: 'codex',
    roles: {
      planner: { executor: 'codex' },
      executor: { executor: 'codex' },
      reviewer: { executor: 'codex' },
    },
    supervisor: { maxIterations: 1, maxWorkers: 2, verifyCommands: [[process.execPath, '-e', 'process.exit(0)']] },
    ...extra,
  }));
  git(cwd, ['add', '.agent-delegation.json']);
  git(cwd, ['commit', '-q', '-m', 'configure supervisor']);
}

test('supervisor plans, isolates a writer, reviews evidence, and integrates a patch', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd);
  const code = await runMain(['run', 'Implement the requested correction: FAKE_MUTATION', '--approve-all', '--json'], c);
  assert.equal(code, 0, c.errors.join('') + c.output.join(''));
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'completed');
  assert.equal(record.integrated, true);
  assert.equal(record.evidence.accepted, true);
  assert.equal(record.plan.source, 'fallback');
  assert.equal(readFileSync(join(cwd, 'result.txt'), 'utf8'), 'implemented\n');
  assert.equal(listJobs(c.root).length, 3);
  assert.ok(listJobs(c.root).some(job => job.kind === 'task' && job.workspaceRoot !== cwd));
  assert.equal(listSupervisors(c.root)[0].status, 'completed');
  const snapshot = readTaskContext(c.root, record.context.id, record.context.revision);
  assert.equal(snapshot.payload.objective, 'Implement the requested correction: FAKE_MUTATION');
  assert.ok(listJobs(c.root).every(job => job.context?.id === record.context.id && job.request.includes('Shared task context')));
  assert.equal(readTaskEvents(c.root, record.id).filter(event => event.type === 'task.completed').length, 1);
  assert.equal(pendingNotifications(c.root, [...listJobs(c.root), record], 'supervisor-test').at(-1).taskId, record.id);
});

test('supervisor fans out independent typed tasks and integrates both patches', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd, {
    scenario: {
      barrierRequired: true,
      planSteps: [
        { id: 'alpha', role: 'executor', prompt: 'Implement the requested correction: FAKE_ALPHA', files: ['alpha.txt'] },
        { id: 'beta', role: 'executor', prompt: 'Implement the requested correction: FAKE_BETA', files: ['beta.txt'] },
      ],
      mutations: [
        { marker: 'FAKE_ALPHA', file: 'alpha.txt', content: 'alpha\n' },
        { marker: 'FAKE_BETA', file: 'beta.txt', content: 'beta\n' },
      ],
    },
  });
  const code = await runMain(['run', 'Implement the requested correction: FANOUT', '--approve-all', '--json'], c);
  assert.equal(code, 0, c.errors.join('') + c.output.join(''));
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'completed');
  assert.equal(record.taskCount, 2);
  assert.equal(record.parallel.length, 2);
  assert.equal(readFileSync(join(cwd, 'alpha.txt'), 'utf8'), 'alpha\n');
  assert.equal(readFileSync(join(cwd, 'beta.txt'), 'utf8'), 'beta\n');
  assert.equal(listJobs(c.root).length, 5);
  assert.ok(record.parallel.every(item => item.worker.structuredOutput.status === 'completed'));
  c.output.length = 0;
  assert.equal(await runMain(['run', '--resume', '--supervisor-id', record.id, '--json'], c), 0, c.errors.join(''));
  assert.equal(JSON.parse(c.output[0]).id, record.id);
  assert.equal(listJobs(c.root).length, 5);
});

test('parallel plans reject overlapping file ownership before dispatch', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd, {
    scenario: {
      planSteps: [
        { id: 'alpha', role: 'executor', prompt: 'Implement the requested correction: FAKE_ALPHA', files: ['shared/'] },
        { id: 'beta', role: 'executor', prompt: 'Implement the requested correction: FAKE_BETA', files: ['shared/file.txt'] },
      ],
    },
  });
  const code = await runMain(['run', 'Implement the requested correction: FANOUT', '--approve-all', '--json'], c);
  assert.equal(code, 1);
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'failed');
  assert.match(record.errorMessage, /overlapping file ownership/);
  assert.equal(listJobs(c.root).length, 1);
});

test('multi-patch integration preflights every patch before applying any', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd, {
    scenario: {
      barrierRequired: true,
      planSteps: [
        { id: 'alpha', role: 'executor', prompt: 'Implement the requested correction: FAKE_ALPHA', files: ['alpha.txt'] },
        { id: 'beta', role: 'executor', prompt: 'Implement the requested correction: FAKE_BETA', files: ['beta.txt'] },
      ],
      mutations: [
        { marker: 'FAKE_ALPHA', file: 'alpha.txt', content: 'alpha\n' },
        { marker: 'FAKE_BETA', file: 'beta.txt', content: 'beta\n' },
      ],
      parentMutations: [{ marker: 'FAKE_BETA', file: 'beta.txt', content: 'external\n' }],
    },
  });
  const code = await runMain(['run', 'Implement the requested correction: FANOUT', '--approve-all', '--json'], c);
  assert.equal(code, 1);
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'failed');
  assert.match(record.errorMessage, /patch integration failed/);
  assert.equal(existsSync(join(cwd, 'alpha.txt')), false);
  assert.equal(readFileSync(join(cwd, 'beta.txt'), 'utf8'), 'external\n');
});

test('supervisor fails closed when the writer produces no accepted evidence', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd, { scenario: { fail: true } });
  const code = await runMain(['run', 'Implement the requested correction: FAKE_MUTATION', '--approve-all', '--json'], c);
  assert.equal(code, 1);
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'failed');
  assert.match(record.errorMessage, /worker failed|worker produced no Git changes/);
  assert.equal(existsSync(join(cwd, 'result.txt')), false);
});

test('supervisor rejects a completed worker when the reviewer needs attention', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd, { scenario: { reviewVerdict: 'needs-attention' } });
  const code = await runMain(['run', 'Implement the requested correction: FAKE_MUTATION', '--approve-all', '--json'], c);
  assert.equal(code, 1);
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'failed');
  assert.match(record.errorMessage, /reviewer needs attention/);
  assert.equal(existsSync(join(cwd, 'result.txt')), false);
});

test('supervisor refuses recursive runs and resumes terminal records without rerunning', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd);
  c.env.AGENT_DELEGATION_WORKER = '1';
  assert.equal(await runMain(['run', 'recursive', '--json'], c), 1);
  assert.equal(listSupervisors(c.root).length, 0);

  delete c.env.AGENT_DELEGATION_WORKER;
  const first = await runMain(['run', 'Implement the requested correction: FAKE_MUTATION', '--approve-all', '--json'], c);
  assert.equal(first, 0, c.errors.join('') + c.output.join(''));
  const record = JSON.parse(c.output.pop());
  c.output.length = 0;
  const resumed = await runMain(['run', '--resume', '--supervisor-id', record.id, '--json'], c);
  assert.equal(resumed, 0, c.errors.join(''));
  assert.equal(JSON.parse(c.output[0]).id, record.id);
  assert.equal(listJobs(c.root).length, 3);
});

test('cancel stops an active supervisor and its verified child tree', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd, { scenario: { hang: true, barrierRequired: true, planSteps: [
    { id: 'alpha', role: 'executor', prompt: 'Implement the requested correction: FAKE_ALPHA', files: ['alpha.txt'] },
    { id: 'beta', role: 'executor', prompt: 'Implement the requested correction: FAKE_BETA', files: ['beta.txt'] },
  ], mutations: [
    { marker: 'FAKE_ALPHA', file: 'alpha.txt', content: 'alpha\n' },
    { marker: 'FAKE_BETA', file: 'beta.txt', content: 'beta\n' },
  ] } });
  const runner = join(import.meta.dirname, '..', 'scripts', 'agent-runner.mjs');
  const child = spawn(process.execPath, [runner, 'run', 'Implement the requested correction: FAKE_MUTATION', '--approve-all', '--json'], { cwd, env: c.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.resume();
  child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    let record;
    // Poll until the supervisor dispatches both workers. The deadline only
    // bounds a failure, so a loaded machine does not turn this into a flaky test.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      record = listSupervisors(c.root).find(item => item.status === 'running');
      if (record?.parallel?.filter(item => item.jobId).length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(record?.parallel?.filter(item => item.jobId).length, 2, 'supervisor should reach parallel worker dispatch');
    assert.equal(await runMain(['cancel', record.id], c), 0, c.errors.join(''));
    await closed;
    assert.equal(listSupervisors(c.root)[0].status, 'cancelled');
    assert.equal(listJobs(c.root).filter(job => job.kind === 'task').length, 2);
    assert.ok(listJobs(c.root).filter(job => job.kind === 'task').every(job => job.status === 'cancelled'));
  } finally {
    child.kill();
  }
});

test('supervisor can complete its evidence loop without integrating', async () => {
  const cwd = repository();
  config(cwd);
  const c = context(cwd);
  const code = await runMain(['run', 'Implement the requested correction: FAKE_MUTATION', '--approve-all', '--no-integrate', '--json'], c);
  assert.equal(code, 0, c.errors.join(''));
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'completed');
  assert.equal(record.integrated, false);
  assert.equal(existsSync(join(cwd, 'result.txt')), false);
  assert.equal(listJobs(c.root).length, 3);
});

test('monitor runs only after a failed evidence gate and cannot bypass rejection', async () => {
  const cwd = repository();
  config(cwd, { supervisor: { maxIterations: 1, maxWorkers: 1, monitorRole: 'monitor', verifyCommands: [] }, roles: {
    planner: { executor: 'codex' }, executor: { executor: 'codex' }, reviewer: { executor: 'codex' }, monitor: { executor: 'claude', purpose: 'monitor' },
  } });
  const c = context(cwd, { scenario: { reviewVerdict: 'needs-attention' } });
  assert.equal(await runMain(['run', 'Implement the requested correction', '--approve-all', '--json'], c), 1);
  const record = JSON.parse(c.output[0]);
  assert.equal(record.status, 'failed'); assert.equal(record.monitor.status, 'completed');
  assert.match(record.errorMessage, /reviewer needs attention/);
  const monitor = listJobs(c.root).find(job => job.role === 'monitor');
  assert.equal(monitor.write, false); assert.equal(monitor.jobClass, 'review');
  assert.equal(existsSync(join(cwd, 'result.txt')), false);
  assert.equal(readTaskEvents(c.root, record.id).filter(e => e.type === 'monitor.result').length, 1);
  assert.equal(readTaskEvents(c.root, record.id).at(-1).type, 'task.failed');
  assert.match(readTaskContext(c.root, record.context.id).payload.evidence[0], /Monitor recommendation/);
});

test('supervisor rejects a role without structured output before creating a run', async () => {
  const cwd = makeTempDir('supervisor-structured-');
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify({ supervisor: { executorRole: 'executor' }, roles: { executor: { executor: 'opencode' } } }));
  const env = { ...process.env, AGENT_DELEGATION_DATA: cwd, AGENT_SESSION_ID: 'structured' };
  await assert.rejects(() => runSupervisor({ cwd, env, task: 'anything' }), /executor routes to opencode\/cli, which has no schema-constrained output/);
  assert.deepEqual(listSupervisors(taskRoot(cwd, env)), []);
});
