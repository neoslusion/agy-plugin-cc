import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from '../lib/args.mjs';
import { loadDelegationConfig } from '../lib/delegation-config.mjs';
import { configureProject } from '../lib/orchestration.mjs';
import { taskRoot } from '../lib/task-api.mjs';
import { listJobs } from '../lib/state.mjs';
import { readTaskEvents } from '../lib/task-events.mjs';
import { runCommand } from '../lib/process.mjs';

const plugin = resolve(import.meta.dirname, '../../plugins/agent-delegation');
export const BEHAVIOR_CASES = [
  { name: 'small-auto', mode: 'auto', delegation: false, prompt: 'Fix the spelling of greeting in README.md.', small: true },
  { name: 'independent-auto', mode: 'auto', delegation: true, prompt: 'Implement normalizeEmail in email.mjs and summarizeNumbers in numbers.mjs according to checks.mjs. These modules have independent file ownership: email.mjs and numbers.mjs. Complete both implementations and run the acceptance checks.' },
  { name: 'independent-manual', mode: 'manual', delegation: false, prompt: 'Implement normalizeEmail in email.mjs and summarizeNumbers in numbers.mjs according to checks.mjs. Complete both implementations and run the acceptance checks.' },
  { name: 'user-override', mode: 'auto', delegation: false, prompt: 'Implement normalizeEmail in email.mjs and summarizeNumbers in numbers.mjs according to checks.mjs. Fix this directly without delegation and run the acceptance checks.' },
];

export function createBehaviorFixture(host, config, scenario) {
  const cwd = mkdtempSync(join(tmpdir(), `orchestration-${scenario.name}-`));
  // Force tracked external routes so native-agent claims cannot masquerade as worker evidence.
  const roles = Object.fromEntries(Object.entries(config.roles).map(([name, role]) => [name, { ...role, transport: 'cli' }]));
  if (!roles.executor) roles.executor = { executor: config.defaultExecutor, purpose: 'executor', transport: 'cli' };
  const settings = { ...config, roles, orchestrator: { ...config.orchestrator, host }, automation: { ...config.automation, mode: scenario.mode } };
  delete settings.configPath;
  writeFileSync(join(cwd, '.agent-delegation.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(cwd, 'README.md'), 'A greting utility.\n');
  if (!scenario.small) {
    writeFileSync(join(cwd, 'email.mjs'), 'export function normalizeEmail(value) { throw new Error("TODO"); }\n');
    writeFileSync(join(cwd, 'numbers.mjs'), 'export function summarizeNumbers(values) { throw new Error("TODO"); }\n');
    writeFileSync(join(cwd, 'checks.mjs'), `import assert from 'node:assert/strict';
import { normalizeEmail } from './email.mjs';
import { summarizeNumbers } from './numbers.mjs';
assert.equal(normalizeEmail('  Alice@EXAMPLE.COM '), 'alice@example.com');
assert.throws(() => normalizeEmail(null), TypeError);
assert.deepEqual(summarizeNumbers([3, -1, 2]), { count: 3, sum: 4, min: -1, max: 3 });
assert.deepEqual(summarizeNumbers([]), { count: 0, sum: 0, min: null, max: null });
assert.throws(() => summarizeNumbers([Infinity]), TypeError);
console.log('Acceptance passed');
`);
  }
  configureProject({ cwd, host });
  const expected = scenario.small ? null : readFileSync(join(cwd, 'checks.mjs'), 'utf8');
  return { cwd, expected, sessionId: `behavior-${scenario.name}`, data: join(cwd, 'runtime-data') };
}

export function behaviorHostSpec(host, { model, pluginPath = plugin } = {}) {
  if (host === 'claude') return ['--print', '--output-format', 'stream-json', '--verbose', '--plugin-dir', pluginPath,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash(node *),Bash(rtk proxy node *)', ...(model ? ['--model', model] : [])];
  if (host === 'codex') return ['--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(model ? ['--model', model] : []), '-'];
  throw new Error('--host must be codex or claude');
}

export function assessBehavior(scenario, { parentSucceeded, jobs, checksPassed, checksIntact }) {
  const externalDelegation = jobs.length > 0;
  const workersCompleted = jobs.every(job => job.status === 'completed');
  return { externalDelegation, workersCompleted, checksPassed, checksIntact,
    passed: parentSucceeded && checksPassed && checksIntact && workersCompleted && externalDelegation === scenario.delegation };
}

async function runParent(binary, args, fixture, prompt, env, timeoutMs) {
  const transcript = join(fixture.cwd, 'parent-transcript.jsonl'), errors = join(fixture.cwd, 'parent-stderr.log');
  writeFileSync(transcript, ''); writeFileSync(errors, '');
  return new Promise(resolveExit => {
    const script = /\.(mjs|cjs|js)$/i.test(binary);
    const child = spawn(script ? process.execPath : binary, script ? [binary, ...args] : args,
      { cwd: fixture.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => appendFileSync(transcript, chunk));
    child.stderr.on('data', chunk => appendFileSync(errors, chunk));
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); resolveExit({ code: null, error: error.message, transcript, errors }); });
    child.once('close', code => { clearTimeout(timer); resolveExit({ code, timedOut, transcript, errors }); });
    child.stdin.end(prompt);
  });
}

export async function evaluateBehavior(argv, context = {}) {
  const { opts, positionals } = parseArgs(argv, { extraValue: ['host', 'case'] });
  for (const key of Object.keys(opts)) if (!['host', 'config', 'model', 'executor', 'case', 'timeout-ms'].includes(key)) throw new Error(`Unsupported evaluation flag --${key}`);
  if (positionals.length || !['codex', 'claude'].includes(opts.host)) throw new Error('Use --host codex|claude [--config FILE] [--model MODEL] [--case NAME]');
  const config = loadDelegationConfig(context.cwd ?? process.cwd(), opts.config);
  if (opts.executor) {
    if (!['codex', 'claude', 'agy'].includes(opts.executor)) throw new Error('--executor must be codex, claude or agy');
    config.defaultExecutor = opts.executor;
    config.roles = { ...config.roles, executor: { executor: opts.executor, purpose: 'executor', transport: 'cli' } };
  }
  const cases = opts.case ? BEHAVIOR_CASES.filter(scenario => scenario.name === opts.case) : BEHAVIOR_CASES;
  if (!cases.length) throw new Error(`Unknown case ${opts.case}`);
  const timeoutMs = Number(opts['timeout-ms'] ?? 180000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Evaluation timeout must be 1–600000ms');
  const reports = [];
  const baseEnv = context.env ?? process.env;
  const binary = baseEnv[`${opts.host.toUpperCase()}_BINARY`] ?? opts.host;
  const script = /\.(mjs|cjs|js)$/i.test(binary);
  const version = runCommand(script ? process.execPath : binary, script ? [binary, '--version'] : ['--version'], { env: baseEnv, timeoutMs: 10000 });
  for (const scenario of cases) {
    const fixture = createBehaviorFixture(opts.host, config, scenario);
    const env = { ...(context.env ?? process.env), AGENT_SESSION_ID: fixture.sessionId, AGENT_DELEGATION_DATA: fixture.data, AGENT_DELEGATION_WORKER: '0' };
    (context.out ?? process.stdout).write(`Evaluating ${scenario.name} in ${fixture.cwd}\n`);
    const model = opts.model ?? (config.orchestrator?.host === opts.host ? config.orchestrator.model : undefined);
    const parent = await runParent(binary, behaviorHostSpec(opts.host, { model }), fixture, scenario.prompt, env, timeoutMs);
    const root = taskRoot(fixture.cwd, env), jobs = listJobs(root);
    const content = name => { try { return readFileSync(join(fixture.cwd, name), 'utf8'); } catch { return null; } };
    const checksIntact = scenario.small || content('checks.mjs') === fixture.expected;
    const checks = scenario.small ? { code: content('README.md') === 'A greeting utility.\n' ? 0 : 1 }
      : checksIntact ? runCommand(process.execPath, ['checks.mjs'], { cwd: fixture.cwd, timeoutMs: 10000 }) : { code: 1 };
    const report = { name: scenario.name, host: opts.host, hostVersion: version.code === 0 ? version.stdout.trim().slice(0, 256) : null, model: model ?? null,
      prompt: scenario.prompt, configuration: content('.agent-delegation.json'), fixture: fixture.cwd, sessionId: fixture.sessionId, data: fixture.data, parent,
      ...assessBehavior(scenario, { parentSucceeded: parent.code === 0 && !parent.timedOut, jobs, checksPassed: checks.code === 0, checksIntact }),
      jobs: jobs.map(job => ({ id: job.id, executor: job.executor, integration: job.integration, model: job.model, status: job.status, events: readTaskEvents(root, job.id) })),
      checks, recordedAt: new Date().toISOString() };
    writeFileSync(join(fixture.cwd, 'behavior-report.json'), JSON.stringify(report, null, 2));
    reports.push(report);
    (context.out ?? process.stdout).write(`${scenario.name}: ${report.passed ? 'passed' : 'failed or incomplete'}; evidence ${join(fixture.cwd, 'behavior-report.json')}\n`);
    if (jobs.some(job => ['queued', 'running'].includes(job.status)) || parent.timedOut) break;
  }
  return reports.length === cases.length && reports.every(report => report.passed) ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = await evaluateBehavior(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
