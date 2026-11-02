import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runMain } from '../scripts/agent-runner.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';
import { readTaskEvents, appendTaskEvent } from '../scripts/lib/task-events.mjs';
import { loadDelegationConfig } from '../scripts/lib/delegation-config.mjs';
import { MAX_CONSULTATIONS, parseVerdict, workerTranscript } from '../scripts/lib/advisor.mjs';
import { buildClaudeArgs } from '../scripts/lib/executors/claude.mjs';
import { buildCodexArgs } from '../scripts/lib/executors/codex.mjs';
import { buildOpencodeArgs, runTask as runOpencode } from '../scripts/lib/executors/opencode.mjs';

const fake = join(import.meta.dirname, 'fixtures', 'fake-executor.mjs');
const server = join(import.meta.dirname, '..', 'scripts', 'mcp-server.mjs');
const ROLES = { worker: { executor: 'claude', advisorRole: 'coach' }, coach: { executor: 'codex', model: 'advisor-model' } };

// A git project whose worker is the fake Claude CLI and whose advisor is the fake Codex CLI.
function project(scenario = {}, roles = ROLES) {
  const cwd = mkdtempSync(join(tmpdir(), 'advisor-test-'));
  spawnSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify({ roles }));
  spawnSync('git', ['add', '-A'], { cwd });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd });
  writeFileSync(join(cwd, 'edited.txt'), 'worker change\n');
  const env = { ...process.env, AGENT_DELEGATION_DATA: cwd, AGENT_SESSION_ID: 'advisor-host', CLAUDE_BINARY: fake, CODEX_BINARY: fake,
    FAKE_EXECUTOR_SCENARIO: JSON.stringify(scenario), FAKE_EXECUTOR_STATE: join(cwd, 'fake-state.json') };
  const calls = () => JSON.parse(readFileSync(env.FAKE_EXECUTOR_STATE, 'utf8'));
  return { cwd, env, calls, root: taskRoot(cwd, env) };
}
async function delegate(p, prompt = 'Fix the bug') {
  const out = [], err = [];
  const code = await runMain(['delegate', '--role', 'worker', '--approve-all', '--wait', '--wait-timeout-ms', '60000', '--json', '--', prompt],
    { cwd: p.cwd, env: p.env, out: { write: text => out.push(text) }, err: { write: text => err.push(text) } });
  assert.equal(code, 0, err.join(''));
  return JSON.parse(out.join(''));
}
const events = (p, id, type) => readTaskEvents(p.root, id).filter(event => event.type === type);

test('a REVISE verdict resumes the worker session with the guidance until the advisor approves', async () => {
  const p = project({ turns: [{ response: 'first attempt' }, { response: 'fixed the empty case' }], advisorReplies: ['REVISE: handle the empty input case', 'APPROVE'] });
  const snapshot = await delegate(p);
  const result = snapshot.task.result;
  assert.equal(snapshot.status, 'completed');
  assert.equal(result.response, 'fixed the empty case');
  assert.deepEqual({ reviews: result.advisor.reviews, verdict: result.advisor.verdict }, { reviews: 2, verdict: 'APPROVE' });
  const { worker, advisor } = p.calls();
  assert.equal(worker.length, 2);
  assert.match(worker[0].prompt, /consult_advisor/);
  assert.ok(worker[0].args.includes('--mcp-config') && worker[0].args.join(' ').includes('--advisor-task'));
  assert.deepEqual(worker[1].args.slice(worker[1].args.indexOf('--resume'), worker[1].args.indexOf('--resume') + 2), ['--resume', 'claude-conv']);
  assert.match(worker[1].prompt, /handle the empty input case/);
  // The advisor reviews with the assignment, the worker's handoff and transcript, and the workspace diff.
  assert.equal(advisor.length, 2);
  assert.ok(advisor[0].args.includes('advisor-model') && advisor[0].args.includes('read-only'));
  assert.match(advisor[0].prompt, /Fix the bug/);
  assert.match(advisor[0].prompt, /Worker: first attempt/);
  assert.match(advisor[0].prompt, /edited\.txt/);
  assert.deepEqual(events(p, snapshot.taskId, 'advisor.reviewed').map(event => event.data.verdict), ['REVISE', 'APPROVE']);
});

test('the advisor answers or escalates BLOCKED reports, and escalations reach the parent', async () => {
  const p = project({ turns: [{ response: 'Partial work.\nBLOCKED: which API version should I target?' }], advisorReplies: ['ESCALATE: the user must choose the API version'] });
  const result = (await delegate(p)).task.result;
  assert.equal(result.advisor.escalation, 'the user must choose the API version');
  assert.equal(p.calls().worker.length, 1);
  assert.match(p.calls().advisor[0].prompt, /stopped with a BLOCKED question/);
});

test('a failed turn gets a recovery review, and the round budget bounds corrections', async () => {
  const stuck = project({ turns: [{ fail: true }, { response: 'recovered' }], advisorReplies: ['REVISE: install dependencies first', 'APPROVE'] });
  const recovered = await delegate(stuck);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.task.result.response, 'recovered');
  assert.match(stuck.calls().advisor[0].prompt, /turn failed/);
  const bounded = project({ advisorReplies: ['REVISE: a', 'REVISE: b'] }, { ...ROLES, worker: { ...ROLES.worker, advisorRounds: 1 } });
  const result = (await delegate(bounded)).task.result;
  assert.equal(bounded.calls().worker.length, 2);
  assert.equal(result.advisor.unresolved, 'b');
});

test('an unavailable advisor is reported without failing the worker result', async () => {
  const p = project({ advisorFail: true });
  const snapshot = await delegate(p);
  assert.equal(snapshot.status, 'completed');
  assert.match(snapshot.task.result.advisor.unavailable, /fixture failure/);
  assert.equal(events(p, snapshot.taskId, 'advisor.unavailable').length, 1);
});

test('the per-task MCP server exposes only consult_advisor, records consultations and enforces the budget', async () => {
  const p = project({ advisorReplies: ['APPROVE', 'Use a guard clause for the empty case.'] });
  const snapshot = await delegate(p);
  const client = new Client({ name: 'worker', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, '--advisor-task', snapshot.taskId, '--state-root', p.root],
    cwd: p.cwd, env: { CODEX_BINARY: fake, FAKE_EXECUTOR_SCENARIO: p.env.FAKE_EXECUTOR_SCENARIO, FAKE_EXECUTOR_STATE: p.env.FAKE_EXECUTOR_STATE, PATH: process.env.PATH }, stderr: 'pipe' }));
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['consult_advisor']);
    const answer = await client.callTool({ name: 'consult_advisor', arguments: { question: 'How should I handle empty input?' } });
    assert.equal(answer.content[0].text, 'Use a guard clause for the empty case.');
    assert.match(p.calls().advisor.at(-1).prompt, /How should I handle empty input\?/);
    assert.equal(events(p, snapshot.taskId, 'advisor.consulted').length, 1);
    for (let i = 1; i < MAX_CONSULTATIONS; i++) appendTaskEvent(p.root, snapshot.taskId, 'advisor.consulted', { ok: true });
    const exhausted = await client.callTool({ name: 'consult_advisor', arguments: { question: 'again?' } });
    assert.match(exhausted.content[0].text, /budget/);
    assert.equal(p.calls().advisor.length, 2);
    assert.equal((await client.callTool({ name: 'delegate_task', arguments: { task: 'x' } }).catch(error => error)).message.includes('Unknown tool'), true);
  } finally { await client.close(); }
});

test('advisor roles are validated', () => {
  const load = roles => () => loadDelegationConfig(project({}, roles).cwd);
  assert.throws(load({ worker: { executor: 'claude', advisorRole: 'missing' } }), /unknown role missing/);
  assert.throws(load({ worker: { executor: 'claude', advisorRole: 'worker' } }), /without its own advisor/);
  assert.throws(load({ worker: { executor: 'claude', advisorRole: 'coach' }, coach: { executor: 'codex', advisorRole: 'worker' } }), /without its own advisor/);
  assert.throws(load({ worker: { executor: 'claude', advisorRounds: 1 } }), /requires advisorRole/);
  assert.throws(load({ ...ROLES, worker: { ...ROLES.worker, advisorRounds: 9 } }), /0 to 5/);
});

test('each CLI executor receives the per-task advisor server', async () => {
  const advisorServer = { name: 'delegation_advisor', command: 'node', args: ['mcp-server.mjs', '--advisor-task', 'task-1', '--state-root', 'root'] };
  const claude = buildClaudeArgs({ options: { advisorServer } });
  assert.deepEqual(JSON.parse(claude[claude.indexOf('--mcp-config') + 1]), { mcpServers: { delegation_advisor: { command: 'node', args: advisorServer.args } } });
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], 'mcp__delegation_advisor__consult_advisor');
  const codex = buildCodexArgs({ options: { advisorServer } }).join(' ');
  assert.match(codex, /mcp_servers\.delegation_advisor\.default_tools_approval_mode="approve"/);
  assert.match(codex, /mcp_servers\.delegation_advisor\.args=\["mcp-server\.mjs","--advisor-task","task-1"/);
  assert.ok(buildOpencodeArgs({ options: { advisorServer } }).includes('--standalone'));
  assert.ok(!buildOpencodeArgs({ options: {} }).includes('--standalone'));
  // OpenCode receives the server through inline configuration, merged with the user's own.
  const dir = mkdtempSync(join(tmpdir(), 'fake-opencode-env-'));
  const binary = join(dir, 'opencode.mjs');
  writeFileSync(binary, `import { writeFileSync } from 'node:fs';
for await (const chunk of process.stdin);
writeFileSync(${JSON.stringify(join(dir, 'config.json'))}, process.env.OPENCODE_CONFIG_CONTENT);
process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 's', part: {} }) + '\\n');`);
  const result = await runOpencode({ prompt: 'hi', options: { binary, advisorServer } }, { cwd: dir, env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'x', mcp: { mine: { type: 'remote' } } }) } });
  assert.equal(result.status, 'completed', result.error);
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.theme, 'x');
  assert.deepEqual(Object.keys(config.mcp), ['mine', 'delegation_advisor']);
  assert.deepEqual(config.mcp.delegation_advisor.command, ['node', ...advisorServer.args]);
});

test('transcripts render Claude, Codex and OpenCode events, and verdicts parse leniently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'advisor-log-'));
  const log = join(dir, 'job.log');
  const line = event => `[2026-10-22T00:00:00.000Z] out: ${JSON.stringify(event)}`;
  writeFileSync(log, ['# task', line({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude says' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'test failed' }] } }),
    line({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'codex output' } }),
    line({ type: 'tool_use', part: { tool: 'edit', state: { status: 'completed', input: { path: 'a.js' }, output: 'ok' } } }),
    '[2026-10-22T00:00:00.000Z] err: noise', 'out: not json'].join('\n'));
  const transcript = workerTranscript(log);
  for (const expected of ['Worker: claude says', 'Tool call Bash: {"command":"npm test"}', 'Tool result (error): test failed', 'Command npm test (exit 1): codex output', 'Tool call edit: {"path":"a.js"} → ok']) {
    assert.ok(transcript.includes(expected), expected);
  }
  assert.ok(!transcript.includes('noise'));
  assert.deepEqual(parseVerdict('**APPROVE** - looks right'), { verdict: 'APPROVE', guidance: 'looks right' });
  assert.deepEqual(parseVerdict('revise: add a test'), { verdict: 'REVISE', guidance: 'add a test' });
  assert.equal(parseVerdict('I think it is fine'), null);
});
