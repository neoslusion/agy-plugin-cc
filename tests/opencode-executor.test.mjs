import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpencodeArgs, runTask } from '../scripts/lib/executors/opencode.mjs';
import { executorCapabilities } from '../scripts/lib/executors/capabilities.mjs';

// Replays a recorded `opencode run --format json` event stream and captures argv and stdin.
function fakeOpencode(events, { exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-opencode-'));
  const binary = join(dir, 'opencode.mjs');
  writeFileSync(binary, `import { writeFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(join(dir, 'capture.json'))}, JSON.stringify({ args: process.argv.slice(2), input, pwd: process.env.PWD }));
for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n');
process.exit(${exitCode});`);
  return { binary, capture: () => JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')) };
}
const session = 'ses_fixture';
const step = { type: 'step_start', sessionID: session, part: { type: 'step-start' } };

test('opencode arguments keep readers on the plan agent and pass model variants and sessions', () => {
  assert.deepEqual(buildOpencodeArgs({ options: {} }), ['run', '--format', 'json', '--agent', 'plan']);
  assert.deepEqual(buildOpencodeArgs({ options: { approveAll: true, model: 'opencode/glm-5.3-flash-free', effort: 'high', conversation: session } }),
    ['run', '--format', 'json', '--auto', '--model', 'opencode/glm-5.3-flash-free#high', '--session', session]);
  assert.deepEqual(buildOpencodeArgs({ job: { jobClass: 'review' }, options: { approveAll: true } }), ['run', '--format', 'json', '--agent', 'plan']);
  assert.deepEqual(buildOpencodeArgs({ options: { readOnly: true, approveAll: true } }), ['run', '--format', 'json', '--agent', 'plan']);
  assert.throws(() => buildOpencodeArgs({ options: { jsonSchema: '{}' } }), /schema-constrained/);
  assert.equal(executorCapabilities('opencode').structuredOutput, false);
});

test('an opencode run reports text, session, edited files and step usage, with the prompt on stdin', async () => {
  const fake = fakeOpencode([
    step,
    // Shape recorded from opencode v2.1.2: the edit input uses `path` and metadata lists project-relative files.
    { type: 'tool_use', sessionID: session, part: { type: 'tool', tool: 'edit', state: { status: 'completed', input: { path: 'C:\p\src\a.js' }, metadata: { metadata: { files: [{ file: 'src/a.js', status: 'modified' }] } } } } },
    { type: 'tool_use', sessionID: session, part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { path: 'src/c.js' } } } },
    { type: 'tool_use', sessionID: session, part: { type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'src/b.js' } } } },
    { type: 'step_finish', sessionID: session, part: { type: 'step-finish', cost: 0, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } } } },
    step,
    { type: 'text', sessionID: session, part: { type: 'text', text: 'DONE' } },
  ]);
  const tools = [];
  // OpenCode resolves its project from PWD, so a stale inherited value must not leak through.
  const result = await runTask({ prompt: 'x'.repeat(40_000), options: { binary: fake.binary, approveAll: true }, onProgress: event => event.type === 'tool' && tools.push(event.name) }, { cwd: tmpdir(), env: { ...process.env, PWD: '/somewhere/else' } });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.response, 'DONE');
  assert.equal(result.conversationId, session);
  assert.deepEqual(result.changedFiles, ['src/a.js', 'src/c.js']);
  assert.deepEqual(result.usage, { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 0, cost: 0 });
  assert.deepEqual(tools, ['edit', 'write', 'read']);
  assert.equal(fake.capture().input.length, 40_000);
  assert.equal(fake.capture().pwd, tmpdir());
});

test('opencode error events, nonzero exits and empty runs fail the task', async () => {
  const errored = await runTask({ prompt: 'hi', options: { binary: fakeOpencode([{ type: 'error', sessionID: session, error: { type: 'provider.no-route', message: 'Model unavailable: opencode/missing' } }], { exitCode: 1 }).binary } }, { cwd: tmpdir() });
  assert.equal(errored.status, 'failed');
  assert.match(errored.error, /Model unavailable/);
  const crashed = await runTask({ prompt: 'hi', options: { binary: fakeOpencode([step], { exitCode: 2 }).binary } }, { cwd: tmpdir() });
  assert.equal(crashed.status, 'failed');
  const empty = await runTask({ prompt: 'hi', options: { binary: fakeOpencode([]).binary } }, { cwd: tmpdir() });
  assert.equal(empty.status, 'failed');
  assert.match(empty.error, /without running a step/);
});
