import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.FAKE_EXECUTOR_SCENARIO ?? '{}');
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
if (args.includes('--version')) { console.log('fake executor 1.0'); process.exit(0); }
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_EXECUTOR_CAPTURE) writeFileSync(process.env.FAKE_EXECUTOR_CAPTURE, JSON.stringify({ args, prompt, cwd: process.cwd() }));
if (scenario.delayMs) await new Promise(resolve => setTimeout(resolve, scenario.delayMs));
const supervisorStage = prompt.includes('planning stage of a supervisor') || prompt.includes('independent evidence reviewer') || prompt.includes('Assess this failed evidence gate');
const worker = prompt.includes('Implement the requested correction');
const assignment = prompt.includes('Plan step ') ? prompt.slice(prompt.lastIndexOf('Plan step ')) : prompt;
if (worker && !supervisorStage) {
  const mutation = Array.isArray(scenario.mutations)
    ? scenario.mutations.find(item => assignment.includes(item.marker))
    : (process.env.FAKE_EXECUTOR_MUTATION ? JSON.parse(process.env.FAKE_EXECUTOR_MUTATION) : null);
  if (mutation) {
    const target = join(process.cwd(), mutation.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mutation.content);
  }
}
if (worker && !supervisorStage && Array.isArray(scenario.parentMutations) && process.env.FAKE_EXECUTOR_PARENT_DIR) {
  const mutation = scenario.parentMutations.find(item => assignment.includes(item.marker));
  if (mutation) {
    const target = join(process.env.FAKE_EXECUTOR_PARENT_DIR, mutation.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mutation.content);
  }
}
if (worker && !supervisorStage && process.env.FAKE_EXECUTOR_BARRIER) {
  const barrier = process.env.FAKE_EXECUTOR_BARRIER;
  mkdirSync(barrier, { recursive: true });
  writeFileSync(join(barrier, `${process.pid}.ready`), 'ready');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (readdirSync(barrier).filter(file => file.endsWith('.ready')).length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (scenario.barrierRequired && readdirSync(barrier).filter(file => file.endsWith('.ready')).length < 2) process.exit(2);
}
if (scenario.hang && !supervisorStage) await new Promise(resolve => setTimeout(resolve, 60_000));
if (scenario.malformed && !supervisorStage) { console.log('broken JSON'); process.exit(0); }
if (scenario.noResult && !supervisorStage) process.exit(0);
// With FAKE_EXECUTOR_STATE set, calls are recorded and scripted in order: advisor prompts answer
// with scenario.advisorReplies and worker turns with scenario.turns ({ response, fail }).
let scripted = null;
if (process.env.FAKE_EXECUTOR_STATE) {
  const statePath = process.env.FAKE_EXECUTOR_STATE;
  let state = { advisor: [], worker: [] };
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  const advising = prompt.includes('You are the advisor for a delegated coding worker');
  const calls = advising ? state.advisor : state.worker;
  scripted = advising ? { response: scenario.advisorReplies?.[calls.length] ?? 'APPROVE', fail: Boolean(scenario.advisorFail) } : scenario.turns?.[calls.length] ?? null;
  calls.push({ args, prompt });
  writeFileSync(statePath, JSON.stringify(state));
}
const response = scripted?.response ?? scenario.response ?? 'PONG\n';
const fail = scripted ? Boolean(scripted.fail) : Boolean(scenario.fail && !supervisorStage);
function readSchema() {
  const raw = value(args.includes('--output-schema') ? '--output-schema' : '--json-schema');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return JSON.parse(readFileSync(raw, 'utf8')); }
}
function structuredForSchema(schema) {
  if (schema?.properties?.steps && Array.isArray(scenario.planSteps)) {
    return {
      summary: scenario.planSummary ?? 'fixture plan',
      steps: scenario.planSteps,
    };
  }
  if (schema?.properties?.status) {
    return {
      status: scenario.taskStatus ?? 'completed',
      summary: scenario.taskSummary ?? 'fixture task completed',
      changedFiles: Array.isArray(scenario.changedFiles) ? scenario.changedFiles : [],
      checks: [],
      blockers: Array.isArray(scenario.blockers) ? scenario.blockers : [],
    };
  }
  if (!schema?.properties?.verdict) return { answer: 'PONG' };
  const verdict = scenario.reviewVerdict ?? 'approve';
  return {
    verdict,
    summary: verdict === 'approve' ? 'fixture review' : 'fixture review found an issue',
    findings: verdict === 'approve' ? [] : [{ title: 'fixture finding' }],
    next_steps: [],
  };
}
if (args.includes('exec')) {
  emit({ type: 'thread.started', thread_id: value('resume') && args.includes('resume') ? args.at(-2) : 'codex-conv' });
  const schema = readSchema();
  emit({ type: 'item.completed', item: { type: 'agent_message', text: schema ? JSON.stringify(structuredForSchema(schema)) : response } });
  emit(fail ? { type: 'turn.failed', error: { message: 'fixture failure' } } : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
} else {
  const schema = readSchema();
  emit({ type: 'system', subtype: 'init', session_id: args.includes('--resume') ? value('--resume') : 'claude-conv' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: response }] } });
  emit({ type: 'result', subtype: fail ? 'error_during_execution' : 'success', is_error: fail, result: response,
    errors: fail ? ['fixture failure'] : [], usage: { input_tokens: 1, output_tokens: 2 },
    ...(schema ? { structured_output: structuredForSchema(schema) } : {}) });
}
process.exit(scenario.exitCode ?? 0);
