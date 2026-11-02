import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageDelegation, PLUGIN, ROOT } from '../scripts/dev/package-delegation.mjs';

test('both host manifests package a skill whose runner works from an isolated cache copy', () => {
  packageDelegation();
  const codex = JSON.parse(readFileSync(join(PLUGIN, '.codex-plugin', 'plugin.json')));
  const claude = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json')));
  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, claude.version);
  const cache = mkdtempSync(join(tmpdir(), 'delegation-cache-'));
  cpSync(PLUGIN, join(cache, 'agent-delegation'), { recursive: true });
  const runner = join(cache, 'agent-delegation', 'scripts', 'agent-runner.mjs');
  const res = spawnSync(process.execPath, [runner, 'task', '--executor', 'claude', '--json', 'hello'], {
    cwd: cache, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_BINARY: join(ROOT, 'tests', 'fixtures', 'fake-executor.mjs'), AGENT_DELEGATION_DATA: cache, FAKE_EXECUTOR_SCENARIO: '{}' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).response, 'PONG\n');
  const delegated = spawnSync(process.execPath, [runner, 'delegate', '--executor', 'claude', '--session-id', 'cache-parent', '--wait', '--json', 'hello asynchronously'], {
    cwd: cache, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_BINARY: join(ROOT, 'tests', 'fixtures', 'fake-executor.mjs'), AGENT_DELEGATION_DATA: cache, FAKE_EXECUTOR_SCENARIO: '{}' },
  });
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(JSON.parse(delegated.stdout).task.result.response, 'PONG\n');
  const acp = spawnSync(process.execPath, [runner, 'acp-setup', '--check', '--json'], {
    cwd: cache, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AGY_ACP_BINARY: '', PATH: '' },
  });
  assert.equal(acp.status, 1, acp.stderr);
  assert.equal(JSON.parse(acp.stdout).status, 'missing');
  assert.equal(JSON.parse(acp.stdout).protocolVerified, false);
  for (const command of ['doctor', 'providers']) {
    const args = command === 'doctor' ? [command, '--session-id', 'cache-parent', '--json'] : [command, '--json'];
    const report = spawnSync(process.execPath, [runner, ...args], {
      cwd: cache, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AGENT_DELEGATION_DATA: cache, CODEX_BINARY: '', CLAUDE_BINARY: '', AGY_ACP_BINARY: '', PATH: '' },
    });
    assert.equal(report.status, command === 'doctor' ? 0 : 1, report.stderr);
    assert.equal(command === 'doctor' ? JSON.parse(report.stdout).tasks.length : JSON.parse(report.stdout).providers.length, command === 'doctor' ? 1 : 4);
  }
  const configured = spawnSync(process.execPath, [runner, 'configure', '--host', 'claude'], {
    cwd: cache, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(configured.status, 0, configured.stderr);
  const preview = spawnSync(process.execPath, [runner, 'start', '--dry-run'], {
    cwd: cache, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).binary, 'claude');
  const routed = spawnSync(process.execPath, [runner, 'route', '--role', 'advisor', '--host', 'claude'], {
    cwd: cache, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.equal(JSON.parse(routed.stdout).nativeAgent, 'delegation-advisor');
});

test('the packaged MCP server runs from an isolated cache copy without node_modules', async () => {
  packageDelegation();
  const declared = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.delegation;
  assert.deepEqual(declared, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs'] });
  const cache = mkdtempSync(join(tmpdir(), 'delegation-mcp-cache-'));
  cpSync(PLUGIN, join(cache, 'agent-delegation'), { recursive: true });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'packaging-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(cache, 'agent-delegation', 'scripts', 'mcp-server.mjs')], cwd: cache, stderr: 'pipe',
    env: { AGENT_DELEGATION_DATA: cache, CLAUDE_CODE_SESSION_ID: 'cache-parent', CLAUDE_PROJECT_DIR: cache, CLAUDE_BINARY: join(ROOT, 'tests', 'fixtures', 'fake-executor.mjs'), FAKE_EXECUTOR_SCENARIO: '{}' } }));
  try {
    const receipt = JSON.parse((await client.callTool({ name: 'delegate_task', arguments: { task: 'hello', executor: 'claude' } })).content[0].text);
    const result = JSON.parse((await client.callTool({ name: 'task_wait', arguments: { taskId: receipt.taskId, timeoutMs: 20000 } })).content[0].text);
    assert.equal(result.task.result.response, 'PONG\n');
    assert.ok(receipt.wakeCommand.includes(join(cache, 'agent-delegation', 'scripts', 'agent-runner.mjs')));
  } finally { await client.close(); }
});
