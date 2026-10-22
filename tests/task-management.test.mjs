import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runMain } from '../scripts/agent-runner.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';
import { upsertJob, readJobFile } from '../scripts/lib/state.mjs';
import { createJobRecord } from '../scripts/lib/tracked-jobs.mjs';
import { createSupervisorRecord, saveSupervisor, readSupervisor } from '../scripts/lib/supervisor-state.mjs';
import { readTaskEvents } from '../scripts/lib/task-events.mjs';
import { diagnoseTask, processState } from '../scripts/lib/task-doctor.mjs';
import { get } from '../scripts/lib/executors/registry.mjs';
import { probeCodexCatalog, probeClaudeCatalog, probeAcpProtocol } from '../scripts/lib/provider-readiness.mjs';
import { BEHAVIOR_CASES, createBehaviorFixture, assessBehavior, behaviorHostSpec, evaluateBehavior } from '../scripts/dev/evaluate-orchestration.mjs';

const binary = join(import.meta.dirname, 'fixtures/fake-rpc-provider.mjs');
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'task-management-'));
  const env = { ...process.env, AGENT_SESSION_ID: 'parent', AGENT_DELEGATION_DATA: cwd, CODEX_BINARY: binary, CLAUDE_BINARY: binary };
  return { cwd, env, root: taskRoot(cwd, env) };
}
async function command(c, args) {
  let output = '', error = '';
  const code = await runMain(args, { ...c, out: { write: text => { output += text; } }, err: { write: text => { error += text; } } });
  return { code, output, error, json: () => JSON.parse(output) };
}
function job(c, id, extra = {}) {
  const record = createJobRecord({ executor: 'codex', kind: 'task', request: 'continue work', sessionId: 'parent', workspaceRoot: c.cwd,
    overrides: { id, status: 'running', pid: 12345, workerPid: 12346, ...extra } });
  upsertJob(c.root, record); return record;
}

test('doctor never infers death from age, unknown permissions or a missing owner identity', () => {
  const c = fixture(), record = job(c, 'old', { updatedAt: '2000-01-01' });
  assert.equal(diagnoseTask(record, [], () => 'present').stale, false);
  assert.equal(diagnoseTask(record, [], () => 'unknown').stale, false);
  assert.equal(diagnoseTask({ ...record, workerPid: null }, [], () => 'absent').stale, false);
  assert.equal(diagnoseTask(record, [], pid => pid === record.workerPid ? 'present' : 'absent').stale, false);
  assert.equal(processState(process.pid), 'present');
  assert.equal(processState(-1), 'unknown');
});

test('doctor diagnosis is read-only; explicit repair preserves context/session/retry identity and emits one failure', async () => {
  const c = { ...fixture(), processProbe: () => 'absent' };
  const before = job(c, 'crashed', { conversationId: 'native-thread', dispatchFingerprint: 'stable-retry', context: { id: 'ctx', revision: 2 } });
  const scan = await command(c, ['doctor', '--json']);
  assert.equal(scan.code, 0); assert.equal(scan.json().tasks[0].finding, 'processes_exited');
  assert.equal(readJobFile(c.root, before.id).status, 'running');
  const repair = await command(c, ['doctor', before.id, '--repair', '--json']);
  assert.equal(repair.code, 0, repair.error);
  const after = readJobFile(c.root, before.id);
  assert.equal(after.status, 'failed'); assert.equal(after.phase, 'interrupted');
  assert.equal(after.conversationId, before.conversationId); assert.equal(after.dispatchFingerprint, before.dispatchFingerprint);
  assert.deepEqual(after.context, before.context);
  assert.equal(readTaskEvents(c.root, before.id).filter(event => event.type === 'task.failed').length, 1);
  assert.equal((await command(c, ['doctor', before.id, '--repair'])).code, 1);
});

test('doctor repair rejects running owners, foreign tasks, workers and bulk mutation', async () => {
  const c = { ...fixture(), processProbe: () => 'present' };
  job(c, 'active'); job(c, 'foreign', { sessionId: 'other' });
  for (const args of [['doctor', 'active', '--repair'], ['doctor', 'foreign', '--repair'], ['doctor', '--all', '--repair'], ['doctor', '--repair']]) {
    assert.equal((await command(c, args)).code, 1);
  }
  assert.equal((await command({ ...c, env: { ...c.env, AGENT_DELEGATION_WORKER: '1' } }, ['doctor', 'active', '--repair'])).code, 1);
  assert.equal(readJobFile(c.root, 'active').status, 'running');
});

test('doctor recognizes a real exited fixture process using its default OS probe', async () => {
  const c = fixture();
  // A process id is only a hint: the OS may hand it to another process
  // between the fixture exiting and the repair running. The doctor reads a
  // recycled id as "still present" on purpose, so retry with a fresh child
  // until the id stays free for the whole check.
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    assert.equal(child.status, 0);
    const record = job(c, `exited-fixture-${attempt}`, { pid: child.pid, workerPid: child.pid });
    if (processState(child.pid) !== 'absent') continue;
    assert.equal(diagnoseTask(record, []).stale, true);
    const result = await command(c, ['doctor', record.id, '--repair', '--json']);
    if (result.code !== 0) continue;
    assert.equal(readJobFile(c.root, record.id).status, 'failed');
    return;
  }
  assert.fail('the exited fixture process id was recycled before the repair could confirm it');
});

test('doctor keeps supervisor checkpoints resumable and reports unresolved children', async () => {
  const c = { ...fixture(), processProbe: () => 'absent' };
  const run = createSupervisorRecord({ cwd: c.cwd, task: 'resume safely', config: {}, sessionId: 'parent' });
  Object.assign(run, { pid: 12345, phase: 'reviewing', attempt: 2 }); saveSupervisor(c.root, run);
  job(c, 'child', { supervisorId: run.id, sessionId: `supervisor:${run.id}` });
  const result = await command(c, ['doctor', run.id, '--json']);
  assert.deepEqual(result.json().tasks[0].activeChildTaskIds, ['child']);
  assert.match(result.json().tasks[0].actions.join('\n'), /run --resume/);
  assert.equal((await command(c, ['doctor', run.id, '--repair'])).code, 1);
  assert.equal(readSupervisor(c.root, run.id).phase, 'reviewing');
  assert.equal(readSupervisor(c.root, run.id).status, 'running');
});

test('Codex probe reads paginated models/auth without starting a turn or exposing account identity', async () => {
  const c = fixture(); c.env.RPC_FIXTURE_SCENARIO = JSON.stringify({ modelPages: true });
  c.env.RPC_FIXTURE_CAPTURE = join(c.cwd, 'rpc.jsonl');
  const result = await probeCodexCatalog(binary, c);
  assert.deepEqual(result.models.map(model => model.id), ['fixture-model', 'second-model']);
  assert.equal(result.authenticated, true); assert.equal(result.modelAccessVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /private@example/);
  const calls = readFileSync(c.env.RPC_FIXTURE_CAPTURE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => !['thread/start', 'turn/start'].includes(call.method)));
  assert.equal(calls.find(call => call.method === 'account/read').params.refreshToken, false);
});

test('Codex catalog fails on repeated cursors and exposes missing auth honestly', async () => {
  const c = fixture(); c.env.RPC_FIXTURE_SCENARIO = JSON.stringify({ repeatedCursor: true });
  await assert.rejects(probeCodexCatalog(binary, c), /cursor repeated/);
  c.env.RPC_FIXTURE_SCENARIO = JSON.stringify({ noAccount: true });
  assert.equal((await probeCodexCatalog(binary, c)).authenticated, false);
});

test('Claude catalog uses an empty input stream, bounded lifecycle and sanitizes account data', async () => {
  let captured, closed = false;
  const result = await probeClaudeCatalog(binary, { ...fixture(), queryFactory: input => {
    captured = input;
    return { supportedModels: async () => [{ value: 'worker', displayName: 'Worker', supportedEffortLevels: ['medium'] }],
      accountInfo: async () => ({ email: 'private@example.com', tokenSource: 'subscription' }), close: () => { closed = true; } };
  } });
  assert.equal(typeof captured.prompt, 'object'); assert.deepEqual(captured.options.tools, []);
  assert.equal(closed, true); assert.equal(result.authenticated, null);
  assert.equal(result.models[0].id, 'worker'); assert.doesNotMatch(JSON.stringify(result), /private@example/);
  await assert.rejects(probeClaudeCatalog(binary, { ...fixture(), timeoutMs: 20, queryFactory: () => ({
    supportedModels: () => new Promise(() => {}), accountInfo: () => new Promise(() => {}), close() {},
  }) }), /timed out/);
});

test('providers checks configured models without substitution and reports errors rather than claiming access', async () => {
  const c = fixture();
  writeFileSync(join(c.cwd, '.agent-delegation.json'), JSON.stringify({ roles: { executor: { executor: 'codex', model: 'missing-model' }, reviewer: { executor: 'codex', model: 'fixture-model', effort: 'high' } } }));
  const probe = await command(c, ['providers', '--probe', '--json']);
  assert.equal(probe.code, 1, probe.error);
  assert.equal(probe.json().roles[0].modelListed, false); assert.equal(probe.json().roles[1].effortListed, false);
  assert.equal(probe.json().providers.length, 1);
  assert.equal(probe.json().providers[0].modelAccessVerified, false);
  const missing = await command({ ...c, env: { ...c.env, CODEX_BINARY: join(c.cwd, 'absent.exe') } }, ['providers', '--executor', 'codex', '--json']);
  assert.equal(missing.code, 1); assert.equal(missing.json().providers[0].available, false);
  assert.equal((await command({ ...c, env: { ...c.env, AGENT_DELEGATION_WORKER: '1' } }, ['providers', '--probe'])).code, 1);
});

test('ACP preflight discovers managed pairs; protocol probe does not claim login or model access', async () => {
  const c = fixture(), root = join(c.cwd, '.agent-delegation-runtime', 'antigravity-acp');
  mkdirSync(join(root, 'v1'), { recursive: true });
  writeFileSync(join(root, 'v1', 'agy_acp_server.exe'), 'fixture');
  writeFileSync(join(root, 'v1', 'localharness_external.exe'), 'fixture');
  writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '1.0.0', binary: 'v1/agy_acp_server.exe' }));
  const report = get('agy', 'acp').preflight({ cwd: c.cwd, env: { ...c.env, AGY_ACP_BINARY: '', PATH: '' } });
  assert.equal(report.ready, true); assert.equal(report.runtime.protocolVerified, false);
  const protocol = await probeAcpProtocol(binary, c);
  assert.equal(protocol.protocolVerified, true); assert.equal(protocol.authenticated, null); assert.equal(protocol.models, null);
});

test('ordinary-prompt evaluation rejects claimed delegation, unfinished workers and modified acceptance checks', () => {
  const scenario = BEHAVIOR_CASES.find(item => item.name === 'independent-auto');
  const evidence = { parentSucceeded: true, checksPassed: true, checksIntact: true, jobs: [{ status: 'completed' }] };
  assert.equal(assessBehavior(scenario, evidence).passed, true);
  assert.equal(assessBehavior(scenario, { ...evidence, jobs: [] }).passed, false);
  assert.equal(assessBehavior(scenario, { ...evidence, jobs: [{ status: 'running' }] }).passed, false);
  assert.equal(assessBehavior(scenario, { ...evidence, checksIntact: false }).passed, false);
  const override = BEHAVIOR_CASES.find(item => item.name === 'user-override');
  assert.equal(assessBehavior(override, evidence).passed, false);
});

test('evaluation isolates configuration and preserves instructions, models and automatic/manual cases', () => {
  const config = { defaultExecutor: 'codex', executors: { codex: { model: 'worker' } }, roles: { executor: { executor: 'codex', transport: 'native' } },
    automation: { mode: 'auto', maxParallel: 2 }, orchestrator: { host: 'claude', model: 'parent' } };
  const fixture = createBehaviorFixture('claude', config, BEHAVIOR_CASES.find(item => item.mode === 'manual'));
  const generated = JSON.parse(readFileSync(join(fixture.cwd, '.agent-delegation.json')));
  assert.equal(generated.automation.mode, 'manual'); assert.equal(generated.executors.codex.model, 'worker');
  assert.equal(generated.roles.executor.transport, 'cli'); assert.equal(config.roles.executor.transport, 'native');
  assert.match(readFileSync(join(fixture.cwd, 'CLAUDE.md'), 'utf8'), /manual requires an explicit delegation request/);
  assert.ok(behaviorHostSpec('claude', { model: 'parent' }).includes('--plugin-dir'));
  assert.ok(!behaviorHostSpec('claude').includes('--dangerously-skip-permissions'));
  assert.ok(behaviorHostSpec('codex').includes('workspace-write'));
});

test('evaluation launcher runs a fixture host and retains evidence; missing or edited checks fail honestly', async () => {
  const c = fixture(), host = join(c.cwd, 'fixture-host.mjs');
  writeFileSync(host, `import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fixture-host 1'); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes('spelling')) writeFileSync('README.md', 'A greeting utility.\\n');
else {
  writeFileSync('email.mjs', 'export function normalizeEmail(x) { if (typeof x !== "string") throw new TypeError(); return x.trim().toLowerCase(); }');
  writeFileSync('numbers.mjs', 'export function summarizeNumbers(xs) { if (xs.some(x => !Number.isFinite(x))) throw new TypeError(); return { count: xs.length, sum: xs.reduce((a,b)=>a+b,0), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null }; }');
  if (process.env.EVALUATION_FIXTURE_TAMPER === 'delete') unlinkSync('checks.mjs');
  if (process.env.EVALUATION_FIXTURE_TAMPER === 'edit') writeFileSync('checks.mjs', 'console.log("fake success");');
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Fixture complete' }));
`);
  for (const [name, tamper, expected] of [['small-auto', '', 0], ['independent-manual', '', 0], ['independent-auto', '', 1], ['independent-manual', 'delete', 1], ['independent-manual', 'edit', 1]]) {
    let output = '';
    const code = await evaluateBehavior(['--host', 'claude', '--executor', 'codex', '--case', name], { cwd: c.cwd,
      env: { ...c.env, CLAUDE_BINARY: host, EVALUATION_FIXTURE_TAMPER: tamper }, out: { write: text => { output += text; } } });
    assert.equal(code, expected, output);
    const file = output.split('evidence ').at(-1).trim();
    const report = JSON.parse(readFileSync(file));
    assert.equal(report.hostVersion, 'fixture-host 1'); assert.equal(report.name, name);
    assert.equal(report.passed, expected === 0);
    assert.ok(readFileSync(report.parent.transcript, 'utf8').includes('Fixture complete'));
    if (tamper) assert.equal(report.checksIntact, false);
  }
});
