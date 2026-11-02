import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from './args.mjs';
import { loadDelegationConfig, resolveRoute } from './delegation-config.mjs';
import { createJobRecord, createJobLogFile } from './tracked-jobs.mjs';
import { get } from './executors/registry.mjs';
import { requireCapabilities } from './executors/capabilities.mjs';
import { generateJobId, isoNow, readJobFile, upsertJob, mutateJob } from './state.mjs';
import { withArtifactLock } from './artifact-store.mjs';
import { taskRoot, taskSession } from './task-api.mjs';
import { createTaskContext, contextReference, readTaskContext } from './task-context.mjs';
import { appendTaskEvent } from './task-events.mjs';
import { visibleTasks, selectTask, waitForTask, renderTaskSnapshot, TERMINAL_TASKS } from './task-view.mjs';
import { waitBudget } from './terminal-tasks.mjs';
import { advisorExecution } from './advisor.mjs';

const worker = resolve(import.meta.dirname, '../task-worker.mjs');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = (value, max = 8192) => String(value ?? '').slice(0, max);

function dispatchRoute(config, opts, previous) {
  const sameProvider = previous && (!opts.executor || opts.executor === previous.executor) && (!opts.integration || opts.integration === (previous.integration ?? 'cli')) && (!opts.role || opts.role === previous.role);
  const inherited = previous ? { executor: previous.executor, integration: previous.integration ?? 'cli', model: previous.model ?? undefined, ...previous.execution } : {};
  return resolveRoute(config, {
    ...(sameProvider ? Object.fromEntries(['role', 'executor', 'integration', 'model', 'effort', 'agent', 'advisor', 'timeout-ms'].filter(key => inherited[key] !== undefined).map(key => [key, inherited[key]])) : {}),
    ...(previous && !opts.role && previous.role ? { role: previous.role } : {}),
    ...(previous && (!opts.role || opts.role === previous.role) ? { executor: opts.executor ?? previous.executor } : {}),
    ...opts,
  });
}

export async function runDispatch(command, argv, context = {}) {
  const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
  try {
    if (env.AGENT_DELEGATION_WORKER === '1') throw new Error('A delegated worker cannot launch another task');
    const { opts, positionals } = parseArgs(argv);
    const allowed = ['cwd', 'config', 'session-id', 'role', 'executor', 'integration', 'model', 'effort', 'agent', 'timeout-ms', 'prompt-file', 'context-id', 'context-revision', 'approve-all', 'json-schema', 'request-id', 'json', 'wait', 'wait-timeout-ms', 'fresh'];
    for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw new Error(`--${key} is not supported by ${command}`);
    const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
    const root = taskRoot(cwd, env), sessionId = opts['session-id'] ?? taskSession(env);
    if (!sessionId) throw new Error('Delegation requires a parent session ID (AGENT_SESSION_ID or --session-id)');
    let previous;
    if (command === 'follow-up') {
      if (!positionals.length) throw new Error('follow-up requires a task ID');
      previous = selectTask(root, visibleTasks(root, sessionId), positionals.shift()).task;
      if (previous.kind === 'run' || previous.supervisorId) throw new Error('Use run --resume for supervisors; their child tasks belong to the supervisor');
      if (!TERMINAL_TASKS.has(previous.status)) throw new Error('Task is active; use steer or wait before a follow-up');
    }
    if (opts['prompt-file'] && positionals.length) throw new Error('Use --prompt-file or an inline assignment, not both');
    const prompt = opts['prompt-file'] ? readFileSync(resolve(cwd, opts['prompt-file']), 'utf8') : positionals.join(' ');
    if (!prompt?.trim() || Buffer.byteLength(prompt) > 128 * 1024) throw new Error('An assignment of at most 128 KiB is required');
    if (opts['request-id'] !== undefined && (opts['request-id'].length < 1 || opts['request-id'].length > 128)) throw new Error('--request-id requires 1–128 characters');
    if (opts['context-revision'] && !opts['context-id']) throw new Error('--context-revision requires --context-id');
    if (opts['wait-timeout-ms'] !== undefined && !opts.wait) throw new Error('--wait-timeout-ms requires --wait');
    const config = loadDelegationConfig(cwd, opts.config);
    const route = dispatchRoute(config, opts, previous);
    if (route.transport === 'native') throw new Error(`Role ${route.role} uses native ${route.executor} agent ${route.nativeAgent}; dispatch through the host or explicitly pass --executor ${route.executor}`);
    const adapter = get(route.executor, route.integration);
    requireCapabilities(route.executor, { integration: route.integration, agent: route.agent, advisor: route.advisor, jsonSchema: opts['json-schema'] });
    if (route['timeout-ms'] !== undefined && (!Number.isSafeInteger(Number(route['timeout-ms'])) || Number(route['timeout-ms']) <= 0 || Number(route['timeout-ms']) > 2147000000)) throw new Error('Executor timeout must be a positive integer below 2147000001');
    const timeoutMs = waitBudget(opts['wait-timeout-ms']);
    const sameSession = previous && !opts.fresh && previous.executor === route.executor && (previous.integration ?? 'cli') === route.integration;
    if (sameSession && !previous.conversationId) throw new Error('Previous task has no native session; use --fresh for an explicit handoff');
    let snapshot = opts['context-id'] ? readTaskContext(root, opts['context-id'], opts['context-revision'] === undefined ? null : Number(opts['context-revision'])) : previous?.context ? readTaskContext(root, previous.context.id, previous.context.revision) : null;
    const execution = { ...Object.fromEntries(['role', 'executor', 'integration', 'model', 'effort', 'agent', 'advisor', 'timeout-ms', 'instructions', 'readOnly', 'purpose'].filter(key => route[key] !== undefined).map(key => [key, route[key]])), json: true, 'approve-all': opts['approve-all'] === true && !route.readOnly,
      conversation: sameSession ? previous.conversationId : null, 'json-schema': opts['json-schema'],
      ...(snapshot ? { 'context-id': snapshot.id, 'context-revision': String(snapshot.revision) } : {}),
      ...advisorExecution(config, route),
    };
    const identity = fingerprint({ prompt, execution, previousTaskId: previous?.id ?? null, context: snapshot ? contextReference(snapshot) : null });
    const id = opts['request-id'] ? `task-${fingerprint([sessionId, opts['request-id']]).slice(0, 24)}` : generateJobId('task');
    let child, spawned, created = false;
    const publish = () => withArtifactLock(join(root, 'dispatch', id), () => {
      const existing = readJobFile(root, id);
      if (existing) {
        if (existing.dispatchFingerprint !== identity) throw new Error('Request ID was already used for a different assignment or route');
        return existing;
      }
      if (sameSession && visibleTasks(root, sessionId).some(task => !TERMINAL_TASKS.has(task.status) && task.executor === route.executor && (task.integration ?? 'cli') === route.integration && (task.conversationId === previous.conversationId || task.execution?.conversation === previous.conversationId))) throw new Error('Native session already has an active turn; wait before following up');
      if (!snapshot || (previous && !sameSession && !opts['context-id'])) {
        const payload = snapshot?.payload ?? { objective: previous?.assignment ?? prompt, acceptanceCriteria: [], decisions: [], ownership: {}, evidence: [], blockers: [] };
        snapshot = createTaskContext(root, { ...payload, objective: bounded(payload.objective, 16384),
          ...(previous ? { evidence: [...(payload.evidence ?? []).slice(-16), `Handoff from ${previous.id} (${previous.executor}/${previous.integration ?? 'cli'}), status ${previous.status}: ${bounded(previous.result?.response)}\nChanged files: ${bounded(JSON.stringify(previous.result?.changedFiles ?? []))}\nChecks: ${bounded(JSON.stringify(previous.result?.structuredOutput?.checks ?? []))}`, `New assignment: ${bounded(prompt)}`], blockers: [...(payload.blockers ?? []).slice(-16), ...(previous.result?.structuredOutput?.blockers ?? []).filter(item => typeof item === 'string').slice(0, 16).map(item => bounded(item)), ...(previous.errorMessage ? [bounded(previous.errorMessage)] : [])] } : {}),
        });
      }
      Object.assign(execution, { 'context-id': snapshot.id, 'context-revision': String(snapshot.revision) });
      const record = createJobRecord({ executor: route.executor, kind: 'task', request: prompt, sessionId, workspaceRoot: cwd, overrides: {
        id, role: route.role ?? null, model: route.model ?? null, integration: route.integration, capabilities: adapter.capabilities,
        jobClass: route.readOnly ? 'review' : 'task', write: !route.readOnly,
        context: contextReference(snapshot), previousTaskId: previous?.id ?? null,
        requestId: opts['request-id'] ?? null, dispatchFingerprint: identity, execution,
      } });
      createJobLogFile(root, record);
      const log = openSync(record.logFile, 'a');
      try {
        child = spawn(process.execPath, [worker, root, id], { cwd, env: { ...env, AGENT_SESSION_ID: sessionId, AGENT_DELEGATION_WORKER: '1' }, stdio: ['ignore', log, log], detached: true, windowsHide: true, shell: false });
        spawned = new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
        spawned.catch(() => {});
        record.pid = child.pid;
        record.workerPid = child.pid;
        record.processIdentity = { pid: child.pid, binary: process.execPath, startedAt: isoNow() };
        // Publish the queued event before the record allows the worker to start.
        appendTaskEvent(root, id, 'task.queued', { executor: record.executor, integration: record.integration, role: record.role, context: record.context, previousTaskId: record.previousTaskId });
        upsertJob(root, record);
        created = true;
        return record;
      } catch (error) { child?.kill(); throw error; }
      finally { closeSync(log); }
    });
    const job = sameSession ? withArtifactLock(join(root, 'conversations', fingerprint([route.executor, route.integration, previous.conversationId])), publish) : publish();
    if (child) {
      try { await spawned; child.unref(); }
      catch (error) {
        mutateJob(root, id, current => ({ ...current, status: 'failed', phase: 'failed', completedAt: isoNow(), errorMessage: error.message, pid: null }));
        appendTaskEvent(root, id, 'task.failed', { error: error.message });
        throw error;
      }
    }
    if (opts.wait) {
      const result = await waitForTask(root, sessionId, id, { timeoutMs });
      out.write((opts.json ? JSON.stringify({ ...result, created }) : renderTaskSnapshot(result)) + '\n');
      return result.waitTimedOut || result.status === 'completed' ? 0 : 1;
    }
    const receipt = { taskId: id, status: job.status, created, executor: job.executor, integration: job.integration, role: job.role, context: job.context, previousTaskId: job.previousTaskId };
    out.write(opts.json ? JSON.stringify(receipt) + '\n' : `${created ? 'Delegated' : 'Existing task'} ${id} to ${job.role ?? job.executor} (${job.executor}/${job.integration}).\nUse tasks ${id}, wait ${id}, or watch ${id} with this parent session.\n`);
    return 0;
  } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
}
