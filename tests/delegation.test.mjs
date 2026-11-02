import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runMain } from '../scripts/agent-runner.mjs';
import { buildCodexArgs } from '../scripts/lib/executors/codex.mjs';
import { buildClaudeArgs } from '../scripts/lib/executors/claude.mjs';
import { loadDelegationConfig, resolveRoute } from '../scripts/lib/delegation-config.mjs';
import { listJobs, resolveStateRoot } from '../scripts/lib/state.mjs';
import { workspaceSlug } from '../scripts/lib/workspace.mjs';

const fake = join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');
const agy = join(import.meta.dirname, 'fixtures', 'fake-agy', 'fake-agy.mjs');
const runner = join(import.meta.dirname, '..', 'scripts', 'agent-runner.mjs');
function context(scenario = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'delegation-test-'));
  const out = [], err = [];
  const env = { ...process.env, AGENT_DELEGATION_DATA: cwd, CLAUDE_PLUGIN_DATA: cwd, AGENT_SESSION_ID: 'host-1', CODEX_BINARY: fake, CLAUDE_BINARY: fake, AGY_BINARY: agy,
    FAKE_EXECUTOR_SCENARIO: JSON.stringify(scenario), FAKE_AGY_SCENARIO: '{}', FAKE_EXECUTOR_CAPTURE: join(cwd, 'capture.json') };
  return { cwd, env, out: { write: s => out.push(s) }, err: { write: s => err.push(s) }, output: out, errors: err, root: resolveStateRoot(cwd, workspaceSlug(cwd)) };
}

for (const executor of ['agy', 'codex', 'claude']) {
  test(`${executor}: generic runner produces a normalized, tracked result`, async () => {
    const c = context();
    assert.equal(await runMain(['task', '--executor', executor, '--json', 'hello'], c), 0);
    const result = JSON.parse(c.output[0]);
    assert.equal(result.response, 'PONG\n');
    assert.equal(result.job.executor, executor);
    assert.equal(result.status, 'completed');
    assert.ok(result.job.conversationId);
    assert.equal(listJobs(c.root)[0].status, 'completed');
  });
}

for (const executor of ['codex', 'claude']) {
  test(`${executor}: schema paths, prompt files, and resume survive CLI translation`, async () => {
    const c = context();
    const prompt = 'Fix `a` and $b.\nQuotes: "hello" and --executor agy. Unicode: 日本語';
    writeFileSync(join(c.cwd, 'prompt.txt'), prompt);
    writeFileSync(join(c.cwd, 'schema.json'), JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }));
    assert.equal(await runMain(['task', '--executor', executor, '--prompt-file', 'prompt.txt', '--json-schema', 'schema.json', '--json'], c), 0);
    assert.deepEqual(JSON.parse(c.output[0]).structuredOutput, { answer: 'PONG' });
    assert.equal(JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE)).prompt, prompt);
    c.output.length = 0;
    assert.equal(await runMain(['task', '--executor', executor, '--resume', '--json', 'follow up'], c), 0);
    assert.equal(JSON.parse(c.output[0]).conversationId, `${executor}-conv`);
  });
  for (const scenario of [{ fail: true }, { noResult: true }, { malformed: true }, { exitCode: 3 }]) {
    test(`${executor}: errors fail both the process result and persisted job (${JSON.stringify(scenario)})`, async () => {
      const c = context(scenario);
      assert.equal(await runMain(['task', '--executor', executor, '--json', 'hello'], c), 1);
      assert.equal(JSON.parse(c.output[0]).status, 'failed');
      assert.equal(listJobs(c.root)[0].status, 'failed');
    });
  }
  test(`${executor}: watchdog terminates an unresponsive executor`, async () => {
    const c = context({ hang: true });
    assert.equal(await runMain(['task', '--executor', executor, '--timeout-ms', '300', '--json', 'hello'], c), 1);
    assert.match(JSON.parse(c.output[0]).error, /timed out/);
  });
}

test('routing defaults and roles never carry models across executor overrides', () => {
  const c = context();
  writeFileSync(join(c.cwd, '.agent-delegation.json'), JSON.stringify({ defaultExecutor: 'agy', executors: { codex: { model: 'codex-model' } }, roles: { implement: { executor: 'agy', model: 'agy-model' } }, orchestrator: { host: 'codex', model: 'my-planner' } }));
  const config = loadDelegationConfig(c.cwd);
  assert.equal(resolveRoute(config, { role: 'implement' }).model, 'agy-model');
  assert.equal(resolveRoute(config, { role: 'implement', executor: 'codex' }).model, 'codex-model');
  assert.equal(resolveRoute(config, { role: 'implement', model: 'override' }).model, 'override');
  assert.throws(() => resolveRoute(config, { role: 'missing' }), /Unknown role/);
});

test('role routing works through the actual runner and never inherits host bypass', async () => {
  const c = context();
  c.env.AGY_APPROVE_ALL = '1';
  writeFileSync(join(c.cwd, '.agent-delegation.json'), JSON.stringify({ roles: { implement: { executor: 'claude', model: 'worker-model' } } }));
  assert.equal(await runMain(['task', '--role', 'implement', 'hello'], c), 0);
  const args = JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE)).args;
  assert.ok(args.includes('worker-model'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('resume never crosses executors or parent sessions', async () => {
  const c = context();
  await runMain(['task', '--executor', 'agy', 'first'], c);
  await runMain(['task', '--executor', 'codex', '--resume', 'second'], c);
  assert.ok(!JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE)).args.includes('resume'));
  await runMain(['task', '--executor', 'codex', '--resume', '--session-id', 'host-2', 'third'], c);
  assert.ok(!JSON.parse(readFileSync(c.env.FAKE_EXECUTOR_CAPTURE)).args.includes('resume'));
});

test('review permissions remain restrictive even with explicit approval', () => {
  const input = { job: { jobClass: 'review' }, options: { approveAll: true } };
  assert.ok(buildCodexArgs(input).includes('read-only'));
  assert.ok(!buildCodexArgs(input).includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(buildClaudeArgs(input).includes('Read,Glob,Grep'));
  assert.ok(!buildClaudeArgs(input).includes('--dangerously-skip-permissions'));
});

test('approved Codex writers bypass approvals without also passing -a, which Codex rejects', () => {
  const args = buildCodexArgs({ options: { approveAll: true } });
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('-a'));
  assert.deepEqual(buildCodexArgs({ options: {} }).slice(0, 4), ['-a', 'never', '--sandbox', 'read-only']);
});

test('invalid configuration and conflicting flags fail before execution', async () => {
  const c = context();
  assert.equal(await runMain(['task', '--resume', '--fresh', 'hello'], c), 1);
  assert.equal(await runMain(['task', '--unknown', 'hello'], c), 1);
  writeFileSync(join(c.cwd, '.agent-delegation.json'), '{"roles":{"write":{"approveAll":true}}}');
  assert.equal(await runMain(['task', 'hello'], c), 1);
  assert.equal(listJobs(c.root).length, 0);
});

test('delegated workers cannot recursively launch more executors', async () => {
  const c = context();
  c.env.AGENT_DELEGATION_WORKER = '1';
  assert.equal(await runMain(['task', 'recursive task'], c), 1);
  assert.match(c.errors.join(''), /cannot recursively delegate/);
  assert.equal(listJobs(c.root).length, 0);
});

test('cancel terminates the tracked child and preserves cancelled status', async () => {
  const c = context({ hang: true });
  const child = spawn(process.execPath, [runner, 'task', '--executor', 'claude', '--json', 'wait'], { cwd: c.cwd, env: c.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.resume();
  const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  try {
    let job;
    // Poll until the executor child is tracked. The deadline only bounds a
    // failure, so a loaded machine does not turn this into a flaky test.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      job = listJobs(c.root)[0];
      if (job?.pid && job.pid !== child.pid) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(job?.pid && job.pid !== child.pid, 'executor child should be tracked');
    assert.equal(await runMain(['cancel', job.id], c), 0);
    assert.equal(await finished, 1);
    assert.equal(listJobs(c.root)[0].status, 'cancelled');
    assert.equal(JSON.parse(output).status, 'cancelled');
  } finally { child.kill(); }
});

test('concurrent CLI workers retain every job in a shared workspace', async () => {
  const c = context();
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, 'task', '--executor', i % 2 ? 'codex' : 'claude', `task ${i}`], { cwd: c.cwd, env: { ...c.env, FAKE_EXECUTOR_CAPTURE: join(c.cwd, `capture-${i}.json`) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  })));
  assert.equal(listJobs(c.root).length, 8);
  assert.ok(listJobs(c.root).every(j => j.status === 'completed'));
});
