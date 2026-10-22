import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runMain } from '../scripts/agent-runner.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';

const server = join(import.meta.dirname, '..', 'scripts', 'mcp-server.mjs');
const fake = join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');
const bash = spawnSync('bash', ['-c', 'exit 0'], { windowsHide: true }).status === 0;

// The SDK client passes only a minimal inherited environment, so the server sees exactly what a host provides.
function fixture(scenario = {}, extra = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-delegation-'));
  const env = { AGENT_DELEGATION_DATA: cwd, CLAUDE_CODE_SESSION_ID: 'mcp-parent', CLAUDE_PROJECT_DIR: cwd, CLAUDE_BINARY: fake, CODEX_BINARY: fake,
    FAKE_EXECUTOR_SCENARIO: JSON.stringify(scenario), ...extra };
  return { cwd, env };
}
async function connect({ cwd, env }, script = server) {
  const client = new Client({ name: 'delegation-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], cwd, env, stderr: 'pipe' }));
  return client;
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError, text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
};
function shell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('an MCP client sees the delegation tools, host instructions and the session scope', async () => {
  const c = fixture();
  const client = await connect(c);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['delegation_capabilities', 'delegate_task', 'task_follow_up', 'task_status', 'task_wait', 'task_steer', 'task_interrupt', 'task_cancel']);
    assert.equal(tools.find(tool => tool.name === 'delegate_task').annotations.readOnlyHint, false);
    assert.match(client.getInstructions(), /wakeCommand/);
    const capabilities = (await call(client, 'delegation_capabilities')).json();
    assert.equal(capabilities.sessionId, 'mcp-parent');
    assert.equal(capabilities.project, c.cwd);
    assert.equal(capabilities.stateRoot, taskRoot(c.cwd, c.env));
    assert.equal(capabilities.config.defaultExecutor, 'agy');
    assert.equal(capabilities.providers.length, 3);
  } finally { await client.close(); }
});

test('delegation over MCP is idempotent, follows up, and shares the runner task view', async () => {
  const c = fixture({ delayMs: 1000 });
  const client = await connect(c);
  try {
    const receipt = await call(client, 'delegate_task', { task: 'hello', executor: 'claude', requestId: 'round-1' });
    assert.equal(receipt.isError, false, receipt.text);
    const first = receipt.json();
    assert.equal(first.created, true);
    assert.match(first.wakeCommand, new RegExp(`wait '${first.taskId}' --wake`));
    assert.equal((await call(client, 'task_status', { taskId: first.taskId })).json().workState, 'working');
    const timedOut = (await call(client, 'task_wait', { taskId: first.taskId, timeoutMs: 0 })).json();
    assert.equal(timedOut.waitTimedOut, true);
    const finished = (await call(client, 'task_wait', { taskId: first.taskId, timeoutMs: 20000 })).json();
    assert.equal(finished.status, 'completed');
    assert.equal(finished.task.result.response, 'PONG\n');
    const retry = (await call(client, 'delegate_task', { task: 'hello', executor: 'claude', requestId: 'round-1' })).json();
    assert.deepEqual([retry.taskId, retry.created], [first.taskId, false]);
    const followUp = (await call(client, 'task_follow_up', { taskId: first.taskId, task: 'again', requestId: 'round-2' })).json();
    assert.notEqual(followUp.taskId, first.taskId);
    assert.equal(followUp.previousTaskId, first.taskId);
    assert.equal((await call(client, 'task_wait', { taskId: followUp.taskId, timeoutMs: 20000 })).json().status, 'completed');
    const out = [];
    const code = await runMain(['tasks', '--json'], { cwd: c.cwd, env: { ...process.env, ...c.env, AGENT_SESSION_ID: 'mcp-parent' }, out: { write: text => out.push(text) }, err: { write: () => {} } });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out.join('')).tasks.map(task => task.taskId).sort(), [first.taskId, followUp.taskId].sort());
  } finally { await client.close(); }
});

test('the returned wake command blocks until the result and runs from a plain shell', { skip: !bash && 'bash is unavailable' }, async () => {
  const c = fixture({ delayMs: 1500 });
  const client = await connect(c);
  try {
    const receipt = (await call(client, 'delegate_task', { task: 'hello', executor: 'claude' })).json();
    const started = Date.now();
    const woke = await shell(receipt.wakeCommand);
    assert.equal(woke.code, 0, woke.stderr);
    assert.ok(Date.now() - started >= 500, 'wake returned before the worker finished');
    const snapshot = JSON.parse(woke.stdout);
    assert.equal(snapshot.taskId, receipt.taskId);
    assert.equal(snapshot.task.result.response, 'PONG\n');
  } finally { await client.close(); }
});

test('tool errors are reported as results, and workers get no delegation tools', async () => {
  const c = fixture();
  const client = await connect(c);
  try {
    assert.equal((await call(client, 'delegate_task', { task: ' ' })).isError, true);
    const missing = await call(client, 'task_status', { taskId: 'task-missing' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /task-missing/);
  } finally { await client.close(); }
  const unscoped = await connect(fixture({}, { CLAUDE_CODE_SESSION_ID: '' }));
  try {
    const result = await call(unscoped, 'delegate_task', { task: 'hello', executor: 'claude' });
    assert.equal(result.isError, true);
    assert.match(result.text, /No parent session/);
  } finally { await unscoped.close(); }
  const worker = await connect(fixture({}, { AGENT_DELEGATION_WORKER: '1' }));
  try {
    assert.deepEqual((await worker.listTools()).tools, []);
    assert.match(worker.getInstructions(), /delegated worker/);
  } finally { await worker.close(); }
});
