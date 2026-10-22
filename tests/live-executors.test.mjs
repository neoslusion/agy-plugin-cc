import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMain } from '../scripts/agent-runner.mjs';
import { runCommand } from '../scripts/lib/process.mjs';

for (const executor of ['codex', 'claude']) {
  test(`live ${executor}: task and explicit resume through the generic runner`, { skip: process.env.AGENT_LIVE_TESTS !== '1', timeout: 300_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'delegation-live-'));
    const output = [], errors = [];
    const model = process.env[`AGENT_LIVE_${executor.toUpperCase()}_MODEL`];
    const modelArgs = model ? ['--model', model] : [];
    const ctx = { cwd, env: { ...process.env, AGENT_DELEGATION_DATA: cwd, AGENT_SESSION_ID: `live-${executor}` }, out: { write: s => output.push(s) }, err: { write: s => errors.push(s) } };
    let code = await runMain(['task', '--executor', executor, ...modelArgs, '--timeout-ms', '120000', '--json', 'Reply with exactly PONG. Do not use tools.'], ctx);
    assert.equal(code, 0, output.join('') + errors.join(''));
    const first = JSON.parse(output.join(''));
    assert.equal(first.response.trim(), 'PONG');
    assert.ok(first.conversationId);
    output.length = 0;
    code = await runMain(['task', '--executor', executor, ...modelArgs, '--conversation', first.conversationId, '--timeout-ms', '120000', '--json', 'Repeat your previous response exactly. Do not use tools.'], ctx);
    assert.equal(code, 0, output.join('') + errors.join(''));
    assert.equal(JSON.parse(output.join('')).response.trim(), 'PONG');
  });
}

test('live codex: supervisor plans and fans out owned tasks in a disposable repository', { skip: process.env.AGENT_LIVE_TESTS !== '1', timeout: 600_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delegation-live-supervisor-'));
  const data = mkdtempSync(join(tmpdir(), 'delegation-live-state-'));
  const git = (...args) => {
    const result = runCommand('git', args, { cwd });
    assert.equal(result.code, 0, result.stderr || result.stdout);
  };
  git('init', '-q');
  git('config', 'user.name', 'Live Supervisor');
  git('config', 'user.email', 'live@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'README.md'), '# live supervisor fixture\n');
  const model = process.env.AGENT_LIVE_CODEX_MODEL;
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify({
    defaultExecutor: 'codex',
    executors: model ? { codex: { model } } : {},
    roles: { planner: { executor: 'codex' }, executor: { executor: 'codex' }, reviewer: { executor: 'codex' } },
    supervisor: { maxIterations: 1, maxWorkers: 2, verifyCommands: [] },
  }));
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const output = [], errors = [];
  const ctx = { cwd, env: { ...process.env, AGENT_DELEGATION_DATA: data, AGENT_SESSION_ID: 'live-supervisor' }, out: { write: text => output.push(text) }, err: { write: text => errors.push(text) } };
  const code = await runMain(['run', 'Create alpha.txt containing ALPHA and beta.txt containing BETA. Plan two independent executor steps that own alpha.txt and beta.txt respectively.', '--approve-all', '--json'], ctx);
  assert.equal(code, 0, output.join('') + errors.join(''));
  const record = JSON.parse(output.join(''));
  assert.equal(record.status, 'completed');
  assert.ok(record.taskCount >= 1);
  assert.ok(record.parallel.every(task => task.worker.structuredOutput.status === 'completed'));
  assert.equal(existsSync(join(cwd, 'alpha.txt')), true);
  assert.equal(existsSync(join(cwd, 'beta.txt')), true);
});
