import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMain } from '../scripts/agent-runner.mjs';
import { loadDelegationConfig, resolveRoute } from '../scripts/lib/delegation-config.mjs';
import { configureProject, defaultConfiguration, launchHost, launchSpec } from '../scripts/lib/orchestration.mjs';
import { buildArgs } from '../scripts/lib/executors/agy.mjs';
import { buildClaudeArgs } from '../scripts/lib/executors/claude.mjs';
import { buildCodexArgs } from '../scripts/lib/executors/codex.mjs';

function project(config) {
  const cwd = mkdtempSync(join(tmpdir(), 'orchestration-test-'));
  if (config) writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify(config));
  return cwd;
}

test('auto transport follows the current host without leaking models across executor overrides', () => {
  const config = { ...defaultConfiguration('codex'), executors: { claude: { model: 'claude-model' } } };
  config.roles.advisor.model = 'codex-model';
  config.roles.advisor.instructions = 'Check migration compatibility.';
  assert.equal(resolveRoute(config, { role: 'advisor', host: 'codex' }).transport, 'native');
  assert.equal(resolveRoute(config, { role: 'advisor', host: 'claude' }).transport, 'cli');
  const override = resolveRoute(config, { role: 'advisor', executor: 'claude' });
  assert.equal(override.model, 'claude-model');
  assert.equal(override.readOnly, true);
  assert.match(override.instructions, /Check migration compatibility/);
  assert.equal(resolveRoute(config, { role: 'advisor', executor: 'codex' }).transport, 'cli');
});

for (const host of ['codex', 'claude']) {
  test(`${host}: project setup is repeatable and preserves existing instructions and config`, () => {
    const cwd = project();
    const instructionFile = join(cwd, host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
    const existing = 'User workflow\nKeep my instructions.\n';
    writeFileSync(instructionFile, existing);
    const preview = configureProject({ cwd, host, dryRun: true });
    assert.ok(preview.written.includes('.agent-delegation.json'));
    assert.equal(existsSync(join(cwd, '.agent-delegation.json')), false);
    assert.equal(readFileSync(instructionFile, 'utf8'), existing);
    const result = configureProject({ cwd, host });
    const first = Object.fromEntries(result.written.map(name => [name, readFileSync(join(cwd, name), 'utf8')]));
    configureProject({ cwd, host });
    for (const [name, value] of Object.entries(first)) assert.equal(readFileSync(join(cwd, name), 'utf8'), value);
    assert.ok(readFileSync(instructionFile, 'utf8').startsWith(existing));
    const config = loadDelegationConfig(cwd);
    assert.equal(config.automation.mode, 'auto');
    assert.equal(config.orchestrator.host, host);
    assert.equal(result.written.filter(path => path.includes('/agents/')).length, 3);
    assert.equal(existsSync(join(cwd, `.${host}`, 'config.toml')), false);
    assert.equal(existsSync(join(cwd, `.${host}`, 'settings.json')), false);
  });


  test(`${host}: role changes update generated definitions and retire obsolete files`, () => {
    const config = defaultConfiguration(host);
    config.roles.advisor.model = 'model-v1';
    config.roles.advisor.effort = 'medium';
    const cwd = project(config);
    const ext = host === 'codex' ? 'toml' : 'md';
    const advisor = join(cwd, `.${host}/agents/delegation-advisor.${ext}`);
    configureProject({ cwd, host });
    assert.match(readFileSync(advisor, 'utf8'), /model-v1/);
    config.roles.advisor.model = 'model-v2';
    delete config.roles.planner;
    writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify(config));
    const report = configureProject({ cwd, host });
    assert.match(readFileSync(advisor, 'utf8'), /model-v2/);
    assert.equal(report.removed.length, 1);
    assert.equal(existsSync(join(cwd, `.${host}/agents/delegation-planner.${ext}`)), false);
    assert.equal((readFileSync(advisor, 'utf8').match(/You are a delegated worker/g) ?? []).length, 1);
  });
}
test('configure emits configured orchestrator instructions into the managed block', () => {
  const config = defaultConfiguration('codex');
  config.orchestrator.instructions = 'Keep the parent responsible for integration.';
  const cwd = project(config);
  configureProject({ cwd, host: 'codex' });
  assert.match(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), /Configured orchestrator instructions: Keep the parent responsible for integration\./);
});

test('setup refuses modified agents before changing any other project file', () => {
  const cwd = project();
  configureProject({ cwd, host: 'codex' });
  const file = join(cwd, '.codex/agents/delegation-advisor.toml');
  writeFileSync(file, '# my edited agent');
  const config = loadDelegationConfig(cwd);
  config.roles.planner.model = 'new-model';
  delete config.configPath;
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify(config));
  const planner = readFileSync(join(cwd, '.codex/agents/delegation-planner.toml'), 'utf8');
  assert.throws(() => configureProject({ cwd, host: 'codex' }), /Preserving modified/);
  assert.equal(readFileSync(file, 'utf8'), '# my edited agent');
  assert.equal(readFileSync(join(cwd, '.codex/agents/delegation-planner.toml'), 'utf8'), planner);
});

test('setup rejects malformed blocks and symlinked output directories', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'AGENTS.md'), '<!-- agent-delegation:start -->\nbroken');
  assert.throws(() => configureProject({ cwd, host: 'codex' }), /Malformed/);
  assert.equal(existsSync(join(cwd, '.agent-delegation.json')), false);
  const other = project();
  const linked = project();
  symlinkSync(other, join(linked, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => configureProject({ cwd: linked, host: 'codex' }), /symlink/);
  assert.equal(existsSync(join(other, 'agents')), false);
});

test('invalid configuration fails before native files are generated', () => {
  for (const change of [
    c => { c.automation.mode = 'always'; },
    c => { c.automation.maxParallel = 0; },
    c => { c.roles.advisor.purpose = 'magic'; },
    c => { c.roles.advisor.transport = 'acp'; },
    c => { c.roles.advisor = { executor: 'agy', transport: 'native' }; },
    c => { c.roles['../escape'] = { executor: 'codex', transport: 'native' }; },
    c => { c.roles.advisor.agent = 'overridden'; },
  ]) {
    const config = defaultConfiguration('codex'); change(config);
    const cwd = project(config);
    assert.throws(() => configureProject({ cwd, host: 'codex' }));
    assert.equal(existsSync(join(cwd, '.codex')), false);
  }
});

test('launch model and effort belong to the selected host; permission flags are inherited normally', () => {
  const config = defaultConfiguration('codex');
  config.orchestrator.model = 'gpt-6-astra'; config.orchestrator.effort = 'medium';
  config.automation.maxParallel = 2;
  assert.deepEqual(launchSpec(config), { binary: 'codex', args: ['--model', 'gpt-6-astra', '-c', 'model_reasoning_effort="medium"', '-c', 'agents.enabled=true', '-c', 'agents.max_concurrent_threads_per_session=2'] });
  assert.throws(() => launchSpec(config, 'claude'), /configured for codex/);
  config.orchestrator = { host: 'claude', model: 'sonnet', effort: 'high' };
  assert.deepEqual(launchSpec(config), { binary: 'claude', args: ['--model', 'sonnet', '--effort', 'high'] });
});

test('launcher runs the existing process in the project and propagates its exit', async () => {
  const cwd = project();
  const script = join(cwd, 'capture.mjs');
  writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync('launch.json', JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2)})); process.exitCode=7;");
  const code = await launchHost({ binary: 'codex', args: [script, 'model with spaces', '`$literal`'] }, { cwd, env: { ...process.env, CODEX_BINARY: process.execPath } });
  assert.equal(code, 7);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'launch.json'))), { cwd, args: ['model with spaces', '`$literal`'] });
});

test('new runner commands route native roles, reject wrong hosts, and preview without mutation', async () => {
  const config = defaultConfiguration('codex'); config.roles.advisor.transport = 'native';
  const cwd = project(config), output = [], errors = [];
  const ctx = { cwd, env: { ...process.env, AGENT_DELEGATION_WORKER: '' }, out: { write: text => output.push(text) }, err: { write: text => errors.push(text) } };
  assert.equal(await runMain(['route', '--role', 'advisor', '--host', 'codex'], ctx), 0);
  assert.equal(JSON.parse(output.pop()).nativeAgent, 'delegation-advisor');
  assert.equal(await runMain(['route', '--role', 'advisor', '--host', 'claude'], ctx), 1);
  assert.equal(await runMain(['task', '--role', 'advisor', 'a question'], ctx), 1);
  assert.equal(await runMain(['start', '--dry-run'], ctx), 0);
  assert.equal(JSON.parse(output.pop()).binary, 'codex');
  assert.equal(existsSync(join(cwd, 'AGENTS.md')), false);
  assert.equal(await runMain(['configure', '--host', 'codex', '--model', 'ignored'], ctx), 1);
  ctx.env.AGENT_DELEGATION_WORKER = '1';
  assert.equal(await runMain(['start'], ctx), 1);
});

test('read-only role semantics override bypass for every adapter', () => {
  const options = { readOnly: true, approveAll: true };
  assert.ok(buildArgs({ prompt: 'inspect', options }).includes('plan'));
  assert.ok(buildCodexArgs({ options }).includes('read-only'));
  assert.ok(buildClaudeArgs({ options }).includes('Read,Glob,Grep'));
  for (const args of [buildArgs({ prompt: 'inspect', options }), buildCodexArgs({ options }), buildClaudeArgs({ options })]) {
    assert.equal(args.some(arg => arg.includes('dangerously')), false);
  }
});

test('CLI role dispatch includes its contract and strips bypass from advisor tasks', async () => {
  const config = defaultConfiguration('codex');
  config.roles.advisor = { executor: 'claude', purpose: 'advisor', instructions: 'Compare migration options.' };
  const cwd = project(config), errors = [];
  const capture = join(cwd, 'capture.json');
  const ctx = { cwd, out: { write() {} }, err: { write: text => errors.push(text) }, env: { ...process.env, AGENT_DELEGATION_WORKER: '', AGENT_DELEGATION_DATA: cwd, CLAUDE_BINARY: join(import.meta.dirname, 'fixtures/fake-executor.mjs'), FAKE_EXECUTOR_CAPTURE: capture, FAKE_EXECUTOR_SCENARIO: '{}' } };
  assert.equal(await runMain(['task', '--role', 'advisor', '--approve-all', 'Compare A and B'], ctx), 0, errors.join(''));
  const call = JSON.parse(readFileSync(capture));
  assert.match(call.prompt, /Compare migration options/);
  assert.match(call.prompt, /Compare A and B/);
  assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
});
