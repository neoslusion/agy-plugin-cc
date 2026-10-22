import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { packageDelegation, PLUGIN, ROOT } from '../scripts/dev/package-delegation.mjs';
import { listJobs } from '../scripts/lib/state.mjs';
import { taskRoot } from '../scripts/lib/task-api.mjs';

const SERVER = 'mcp__plugin_agent-delegation_delegation';

// Real Claude Code host with the packaged plugin; the worker is the fixture so only the host makes model calls.
test('live claude host: delegates through MCP, wakes from a background wait, and reports the result', { skip: process.env.AGENT_LIVE_TESTS !== '1', timeout: 400_000 }, async () => {
  packageDelegation();
  const cwd = mkdtempSync(join(tmpdir(), 'delegation-live-host-'));
  // Drop the calling session's scope so the nested host gets its own session, state and plugin data.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PLUGIN_|AGENT_)/.test(key)));
  const env = { ...inherited, AGENT_DELEGATION_DATA: cwd, CLAUDE_BINARY: join(ROOT, 'tests', 'fixtures', 'fake-executor.mjs'), FAKE_EXECUTOR_SCENARIO: JSON.stringify({ delayMs: 5000 }) };
  const model = process.env.AGENT_LIVE_CLAUDE_MODEL;
  const prompt = "Delegate this task with the delegate_task tool using executor claude: 'Say hello.' Then start the returned wakeCommand exactly as given with the Bash tool and run_in_background set to true, and end your turn without polling. When you are re-invoked after it exits, reply with only the worker's response text.";
  const args = ['-p', '--plugin-dir', PLUGIN, '--setting-sources', 'project,local', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', SERVER, 'Bash(AGENT_DELEGATION_DATA=*)', ...(model ? ['--model', model] : []), '--', prompt];
  const events = await new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))) : reject(new Error(`claude exited ${code}: ${stderr}`)));
  });
  const init = events.find(event => event.type === 'system' && event.subtype === 'init');
  assert.deepEqual(init.mcp_servers.find(server => server.name === 'plugin:agent-delegation:delegation')?.status, 'connected');
  const toolUses = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content).filter(block => block.type === 'tool_use');
  assert.ok(toolUses.some(use => use.name === `${SERVER}__delegate_task`), 'host did not call delegate_task');
  assert.ok(toolUses.some(use => use.name === 'Bash' && use.input.run_in_background === true && use.input.command.includes('--wake')), 'host did not start the wake command in the background');
  assert.ok(events.some(event => event.type === 'system' && event.subtype === 'task_notification'), 'background wake did not notify the host');
  assert.match(events.findLast(event => event.type === 'result').result, /PONG/);
  const sessionId = init.session_id;
  const [task] = listJobs(taskRoot(cwd, env)).filter(job => job.sessionId === sessionId);
  assert.equal(task?.status, 'completed');
});
