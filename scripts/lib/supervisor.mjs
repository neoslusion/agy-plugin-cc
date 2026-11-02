import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLogLine, createJobRecord, runTrackedJob } from './tracked-jobs.mjs';
import { get } from './executors/registry.mjs';
import { executorCapabilities } from './executors/capabilities.mjs';
import { loadDelegationConfig, resolveRoute } from './delegation-config.mjs';
import { defaultConfiguration } from './orchestration.mjs';
import { isoNow, readJobFile } from './state.mjs';
import { runCommand } from './process.mjs';
import {
  applyPatch,
  captureWorkerPatch,
  checkPatch,
  cleanupWorkerWorktree,
  createWorkerWorktree,
  patchAlreadyApplied,
  patchPathFor,
  requireCleanParent,
} from './supervisor-git.mjs';
import {
  createSupervisorRecord,
  finishSupervisor,
  readSupervisor,
  resolveSupervisor,
  saveSupervisor,
  updateSupervisor,
} from './supervisor-state.mjs';
import { cleanupFanoutTasks, runFanoutAttempt, validatePlanOwnership } from './supervisor-fanout.mjs';
import { createTaskContext, readTaskContext, reviseTaskContext, contextReference, contextPrompt } from './task-context.mjs';
import { appendTaskEvent } from './task-events.mjs';
import { taskRoot, taskSession } from './task-api.mjs';

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLAN_SCHEMA = join(PLUGIN_ROOT, 'schemas', 'supervisor-plan.schema.json');
const REVIEW_SCHEMA = join(PLUGIN_ROOT, 'schemas', 'review-output.schema.json');
const TASK_SCHEMA = join(PLUGIN_ROOT, 'schemas', 'supervisor-task-result.schema.json');
const MAX_RESPONSE_CHARS = 32 * 1024;
const MAX_DIFF_CHARS = 256 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function bounded(value, max = MAX_RESPONSE_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`;
}

function effectiveConfig(cwd, configFile, host = 'codex') {
  const loaded = loadDelegationConfig(cwd, configFile);
  const fallback = defaultConfiguration(host);
  return {
    ...fallback,
    ...loaded,
    orchestrator: { ...fallback.orchestrator, ...loaded.orchestrator },
    automation: { ...fallback.automation, ...loaded.automation },
    supervisor: { ...fallback.supervisor, ...loaded.supervisor },
    executors: { ...fallback.executors, ...loaded.executors },
    roles: { ...fallback.roles, ...loaded.roles },
  };
}

function childEnvironment(env) {
  const child = { ...env };
  delete child.AGENT_DELEGATION_WORKER;
  return child;
}

function positiveInteger(value, fallback, label, maximum = 16) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return number;
}

function supervisorOptions(config, supplied = {}) {
  const configured = config.supervisor ?? {};
  return {
    maxIterations: positiveInteger(supplied.maxIterations ?? configured.maxIterations, 4, 'maxIterations'),
    maxWorkers: positiveInteger(supplied.maxWorkers ?? configured.maxWorkers, Math.min(config.automation?.maxParallel ?? 2, 4), 'maxWorkers'),
    integrate: supplied.integrate ?? true,
    allowDirty: supplied.allowDirty === true,
    plannerRole: supplied.plannerRole ?? configured.plannerRole ?? 'planner',
    executorRole: supplied.executorRole ?? configured.executorRole ?? 'executor',
    reviewerRole: supplied.reviewerRole ?? configured.reviewerRole ?? 'reviewer',
    monitorRole: supplied.monitorRole ?? configured.monitorRole ?? null,
    verifyCommands: supplied.verifyCommands ?? configured.verifyCommands ?? [],
  };
}

// Verification commands run with the user's privileges and come from project configuration.
// Treat them as executable code: no worker, worktree or check starts before explicit approval.
function requireCheckApproval(settings, supplied) {
  if (settings.verifyCommands.length && supplied.approveAll !== true) {
    throw new Error('supervisor.verifyCommands execute project-configured commands; pass --approve-all to authorize them');
  }
}

// Planner, worker and reviewer turns are validated against JSON schemas, so reject a route that cannot
// produce structured output before any record or worktree is created.
function requireStructuredRoles(config, settings) {
  for (const role of [settings.plannerRole, settings.executorRole, settings.reviewerRole]) {
    const route = resolveCliRoute(config, role);
    if (!executorCapabilities(route.executor, route.integration).structuredOutput) {
      throw new Error(`supervisor role ${role} routes to ${route.executor}/${route.integration}, which has no schema-constrained output; map it to a codex or claude role`);
    }
  }
}

function resolveCliRoute(config, role) {
  const initial = resolveRoute(config, { role });
  return resolveRoute(config, {
    role,
    executor: initial.executor,
    model: initial.model,
    effort: initial.effort,
    agent: initial.agent,
    advisor: initial.advisor,
    'timeout-ms': initial['timeout-ms'],
  });
}

function normalizePlan(value, task, plannerError = null) {
  const candidate = value?.steps ? value : null;
  const seen = new Set();
  const validSteps = Array.isArray(candidate?.steps)
    ? candidate.steps.map((step, index) => {
        if (!step || typeof step.prompt !== 'string' || !step.prompt.trim() || !['executor', 'tester'].includes(step.role)) return null;
        const id = typeof step.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(step.id) ? step.id : `step-${index + 1}`;
        if (seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          role: step.role,
          prompt: step.prompt.trim(),
          files: Array.isArray(step.files) ? step.files.filter(file => typeof file === 'string').slice(0, 64) : [],
        };
      }).filter(Boolean).slice(0, 16)
    : [];
  if (validSteps.length) {
    return {
      summary: typeof candidate.summary === 'string' ? candidate.summary : 'Planner produced an implementation plan.',
      steps: validSteps,
      source: 'planner',
      plannerError,
    };
  }
  return {
    summary: 'Deterministic fallback: implement the requested outcome, then verify the actual patch.',
    steps: [{ id: 'step-1', role: 'executor', prompt: task, files: [] }],
    source: 'fallback',
    plannerError: plannerError ?? 'planner output did not contain a valid bounded plan',
  };
}

function summarizeJob(job) {
  return {
    id: job?.id ?? null,
    executor: job?.executor ?? null,
    role: job?.role ?? null,
    status: job?.status ?? 'failed',
    phase: job?.phase ?? null,
    conversationId: job?.conversationId ?? null,
    error: job?.errorMessage ?? job?.result?.error ?? null,
    response: bounded(job?.result?.response ?? ''),
    structuredOutput: job?.result?.structuredOutput ?? null,
    changedFiles: Array.isArray(job?.result?.changedFiles) ? job.result.changedFiles.slice(0, 256) : [],
    exitCode: job?.exitCode ?? job?.result?.exitCode ?? null,
  };
}

async function runExecutor({ root, cwd, env, config, role, kind, prompt, context = null, schemaPath = null, approveAll = false, conversation = null, sessionId, supervisorId, attempt, options = {}, onJobCreated = () => {} }) {
  const route = resolveCliRoute(config, role);
  const executor = get(route.executor, route.integration);
  const readOnly = kind === 'review' || route.readOnly === true || options.readOnly === true;
  prompt = [route.instructions, context ? contextPrompt(root, context) : null, `Assignment:\n${prompt}`].filter(Boolean).join('\n\n');
  const job = createJobRecord({
    executor: route.executor,
    kind,
    request: prompt,
    sessionId,
    workspaceRoot: cwd,
    overrides: {
      role,
      integration: route.integration,
      capabilities: executor.capabilities,
      context,
      supervisorId,
      attempt,
      jobClass: readOnly ? 'review' : 'task',
      write: !readOnly,
    },
  });
  onJobCreated(job);
  const executionOptions = {
    integration: route.integration,
    stateRoot: root,
    model: route.model,
    effort: route.effort,
    agent: route.agent,
    advisor: route.advisor,
    readOnly,
    approveAll: approveAll === true && !readOnly,
    conversation,
    jsonSchema: schemaPath,
    outputFormat: 'stream-json',
    timeoutMs: route['timeout-ms'] ? Number(route['timeout-ms']) : undefined,
    ...options,
  };
  const final = await runTrackedJob({
    root,
    job,
    run: async progress => {
      const result = await executor.runTask(
        {
          job,
          prompt,
          options: executionOptions,
          onTaskEvent(event) {
            progress.event(event.type, event.data ?? {});
            if (event.type === 'session.started') progress.update({ conversationId: event.data.conversationId });
          },
          onProgress(event) {
            if (event.type === 'spawn') progress.update({ pid: event.pid, processIdentity: { pid: event.pid, binary: event.binary ?? route.executor, startedAt: isoNow() } });
            if (event.type === 'phase') progress.setPhase(event.phase);
            if (event.type === 'tool') progress.log(`tool: ${event.name ?? 'working'}`);
            if (event.type === 'tool') progress.event('tool.started', { name: event.name ?? 'working' });
            if (event.type === 'tool-error') progress.log(`tool error: ${event.message ?? 'unknown'}`);
          },
          onStdoutLine: text => appendLogLine(root, job, `out: ${text.trimEnd()}`),
          onStderrLine: text => appendLogLine(root, job, `err: ${text.trimEnd()}`),
        },
        { cwd, env: childEnvironment(env) },
      );
      progress.update({ conversationId: result.conversationId });
      return result;
    },
  });
  return { job: final, route, summary: summarizeJob(final) };
}

function runChecks(commands, cwd, env) {
  return commands.map(command => {
    const started = Date.now();
    const result = runCommand(command[0], command.slice(1), { cwd, env, timeoutMs: 15 * 60 * 1000 });
    return {
      command,
      code: result.code,
      ok: result.code === 0,
      durationMs: Date.now() - started,
      stdout: bounded(result.stdout, 16 * 1024),
      stderr: bounded(result.stderr, 16 * 1024),
      error: result.error?.message ?? null,
    };
  });
}

function diffForPrompt(patch) {
  if (!patch?.file) return '';
  try {
    return readFileSync(patch.file, 'utf8').slice(0, MAX_DIFF_CHARS);
  } catch {
    return '';
  }
}

function plannerPrompt(task) {
  return [
    'You are the planning stage of a supervisor. Do not edit files.',
    'Return a bounded implementation plan for the objective below. The supervisor will own execution, integration, and verification.',
    'Use only executor or tester steps. Each step must have a unique id, a concrete prompt, and an explicit files ownership list; parallel steps must not overlap.',
    JSON.stringify({ task }),
  ].join('\n\n');
}

function reviewerPrompt(task, worker, patch, checks) {
  return [
    'You are the independent evidence reviewer for a supervisor run. Do not edit files.',
    `Objective:\n${task}`,
    `Worker status: ${worker.status}`,
    `Worker response:\n${worker.response}`,
    `Changed files reported by Git:\n${patch.changedFiles.join(', ') || '(none)'}`,
    `Verification commands:\n${JSON.stringify(checks)}`,
    `Worker patch:\n${diffForPrompt(patch)}`,
    'Inspect the actual isolated worktree and identify concrete defects or missing acceptance evidence. The supervisor will not treat this response as proof by itself.',
  ].join('\n\n');
}

function reviewerEvidence(reviewer) {
  const value = reviewer?.structuredOutput;
  if (!value || !['approve', 'needs-attention'].includes(value.verdict) || typeof value.summary !== 'string' || !Array.isArray(value.findings) || !Array.isArray(value.next_steps)) {
    return { accepted: false, verdict: null, reason: 'reviewer returned invalid structured evidence' };
  }
  if (value.verdict === 'needs-attention') {
    const findings = value.findings.map(finding => finding?.title).filter(Boolean).join('; ');
    return { accepted: false, verdict: value.verdict, reason: `reviewer needs attention: ${value.summary}${findings ? ` (${findings})` : ''}` };
  }
  return { accepted: true, verdict: value.verdict, reason: '' };
}

function workerEvidence(worker) {
  const value = worker?.structuredOutput;
  if (!value || !['completed', 'failed'].includes(value.status) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.changedFiles) || !Array.isArray(value.checks) || !Array.isArray(value.blockers)) {
    return { accepted: false, reason: 'worker returned invalid structured evidence' };
  }
  if (value.status !== 'completed') return { accepted: false, reason: `worker reported failure: ${value.summary}` };
  if (value.blockers.length) return { accepted: false, reason: `worker reported blockers: ${value.blockers.join('; ')}` };
  return { accepted: true, reason: '' };
}

function stepPrompt(task, plan, step, feedback) {
  const owned = step.files.length ? `You own only these paths: ${step.files.join(', ')}.` : 'No path list was supplied; do not edit files outside the stated objective.';
  return [
    `Objective:\n${task}`,
    `Plan step ${step.id} (${step.role}):\n${step.prompt}`,
    `Other planned steps: ${plan.steps.filter(other => other.id !== step.id).map(other => other.id).join(', ') || '(none)'}`,
    owned,
    `Previous evidence feedback:\n${feedback || 'None.'}`,
    'Work only in your isolated worktree. Return the required structured task result, including changed files, checks, and blockers. Do not claim success without evidence.',
  ].join('\n\n');
}


function throwIfCancelled(root, id) {
  const record = readSupervisor(root, id);
  if (record?.status === 'cancelled') throw new Error('supervisor run was cancelled');
}

function safeCleanup(record, env) {
  if (!record?.worktree?.worktreePath) return null;
  return cleanupWorkerWorktree(record.worktree, { env });
}

function buildFailure(record, error) {
  return { ...record, errorMessage: error?.message ?? String(error) };
}

export async function runSupervisor({ cwd, env = process.env, task, configFile, options = {}, resumeId = null } = {}) {
  if (!task?.trim() && resumeId === null) throw new Error('supervisor run requires a task or --task-file');
  if (env.AGENT_DELEGATION_WORKER === '1') throw new Error('a delegated worker cannot start a supervisor run');
  const root = taskRoot(cwd, env);
  let loaded = effectiveConfig(cwd, configFile, options.host ?? 'codex');
  let settings = supervisorOptions(loaded, options);
  requireStructuredRoles(loaded, settings);
  let record;
  if (resumeId !== null) {
    record = resolveSupervisor(root, resumeId);
    if (!record) throw new Error(`supervisor run not found: ${resumeId || 'latest active run'}`);
    if (TERMINAL.has(record.status)) return record;
    loaded = effectiveConfig(cwd, record.configPath ?? configFile, options.host ?? 'codex');
    settings = supervisorOptions(loaded, options);
    requireStructuredRoles(loaded, settings);
    requireCheckApproval(settings, options);
  } else {
    requireCheckApproval(settings, options);
    record = createSupervisorRecord({ cwd, task: task.trim(), config: loaded, options: settings, sessionId: taskSession(env) });
    saveSupervisor(root, record);
  }
  task = record.request;
  if (resumeId !== null && record.pid && record.pid !== process.pid) {
    let alive = true;
    try { process.kill(record.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
    if (alive) throw new Error(`supervisor ${record.id} already has an active process; cancel it before resuming`);
  }
  record = updateSupervisor(root, record.id, { pid: process.pid, processIdentity: { pid: process.pid, binary: process.execPath, startedAt: isoNow() }, configPath: loaded.configPath, maxIterations: settings.maxIterations, maxWorkers: settings.maxWorkers, integrate: settings.integrate, allowDirty: settings.allowDirty });
  appendTaskEvent(root, record.id, 'task.started', { kind: 'supervisor', resumed: resumeId !== null });
  const sessionId = `supervisor:${record.id}`;

  try {
    if (!record.context) {
      const base = runCommand('git', ['rev-parse', 'HEAD'], { cwd, env }).stdout.trim() || null;
      const snapshot = createTaskContext(root, { objective: task, acceptanceCriteria: ['Implement the requested outcome within assigned ownership.', 'Pass configured verification and independent review before integration.'], decisions: [], evidence: [], blockers: [], baseCommit: base });
      record = updateSupervisor(root, record.id, { context: contextReference(snapshot) });
      appendTaskEvent(root, record.id, 'context.updated', { context: record.context });
    }
    if (!record.plan) {
      throwIfCancelled(root, record.id);
      record = updateSupervisor(root, record.id, { phase: 'planning' });
      const planned = await runExecutor({
        root,
        cwd,
        env,
        config: loaded,
        role: settings.plannerRole,
        kind: 'plan',
        prompt: plannerPrompt(task.trim()),
        context: record.context,
        schemaPath: PLAN_SCHEMA,
        approveAll: false,
        sessionId,
        supervisorId: record.id,
        onJobCreated: job => { record = updateSupervisor(root, record.id, { plannerJobId: job.id, childJobIds: [...new Set([...(record.childJobIds ?? []), job.id])] }); },
        attempt: 0,
      });
      const plan = normalizePlan(planned.summary.structuredOutput, task.trim(), planned.summary.error);
      record = updateSupervisor(root, record.id, { plan, planner: planned.summary });
      const previous = readTaskContext(root, record.context.id);
      const snapshot = reviseTaskContext(root, previous.id, { plan, ownership: Object.fromEntries(plan.steps.map(step => [step.id, step.files])) }, previous.revision);
      record = updateSupervisor(root, record.id, { context: contextReference(snapshot) });
      appendTaskEvent(root, record.id, 'context.updated', { context: record.context });
    }

    validatePlanOwnership(record.plan);
    const deps = { runExecutor, runChecks, captureWorkerPatch, patchPathFor, workerEvidence, reviewerEvidence, reviewerPrompt, stepPrompt, taskSchema: TASK_SCHEMA, reviewSchema: REVIEW_SCHEMA, requireCleanParent, createWorkerWorktree };
    let attempt = Math.max(1, Number(record.attempt) || 1);
    while (attempt <= settings.maxIterations) {
      throwIfCancelled(root, record.id);
      const outcome = await runFanoutAttempt({ root, cwd, env, config: loaded, settings, options, plan: record.plan, record, attempt, sessionId, deps });
      record = outcome.record;
      if (!outcome.accepted) {
        const cleanup = cleanupFanoutTasks(outcome.tasks, env);
        let feedback = outcome.reasons.join('\n');
        if (settings.monitorRole) {
          const monitored = await runExecutor({ root, cwd, env, config: loaded, role: settings.monitorRole, kind: 'review',
            prompt: `Assess this failed evidence gate and recommend a bounded intervention. Do not change acceptance criteria.\n${bounded(feedback)}\nTask evidence:\n${bounded(outcome.tasks.map(item => ({ id: item.id, worker: item.worker, reviewer: item.reviewer, checks: item.checks })))}`,
            context: record.context, approveAll: false, sessionId, supervisorId: record.id, attempt,
            onJobCreated: job => updateSupervisor(root, record.id, { monitorJobId: job.id, childJobIds: [...new Set([...(readSupervisor(root, record.id)?.childJobIds ?? []), job.id])] }),
            options: { readOnly: true },
          });
          appendTaskEvent(root, record.id, 'monitor.result', { jobId: monitored.job.id, status: monitored.summary.status, recommendation: bounded(monitored.summary.response, 8192) });
          record = updateSupervisor(root, record.id, { monitor: monitored.summary });
          if (monitored.summary.status === 'completed') feedback += `\nMonitor recommendation (inspect before acting): ${bounded(monitored.summary.response, 8192)}`;
        }
        const previous = readTaskContext(root, record.context.id);
        const snapshot = reviseTaskContext(root, previous.id, { blockers: outcome.reasons, evidence: [`Attempt ${attempt}: ${feedback.slice(0, 16384)}`] }, previous.revision);
        record = updateSupervisor(root, record.id, { context: contextReference(snapshot) });
        appendTaskEvent(root, record.id, 'context.updated', { context: record.context });
        record = updateSupervisor(root, record.id, { phase: 'revising', feedback, cleanup, parallel: null, parallelAttempt: null, worktree: null, workerJobId: null, worker: null, patch: null, reviewerJobId: null, reviewer: null, checks: [], evidence: null, integration: null });
        if (attempt >= settings.maxIterations) {
          record = finishSupervisor(root, record.id, 'failed', { errorMessage: feedback, evidence: { accepted: false, reasons: outcome.reasons }, cleanup, parallel: null });
          return record;
        }
        attempt += 1;
        continue;
      }
      if (settings.integrate) {
        const patches = outcome.tasks.map(item => item.patch).filter(Boolean);
        record = updateSupervisor(root, record.id, { phase: 'integrating', integration: { status: 'pending', patches: patches.map(patch => ({ file: patch.file, hash: patch.hash, changedFiles: patch.changedFiles })), applied: [] } });
        const pending = patches.filter(patch => !patchAlreadyApplied(cwd, patch.file, { env }));
        try {
          for (const patch of pending) checkPatch(cwd, patch.file, { env });
          for (const patch of pending) applyPatch(cwd, patch.file, { env });
        } catch (error) {
          const cleanup = cleanupFanoutTasks(outcome.tasks, env);
          record = finishSupervisor(root, record.id, 'failed', { errorMessage: `patch integration failed: ${error.message}`, integration: { status: 'failed', error: error.message }, cleanup, parallel: outcome.tasks });
          return record;
        }
        record = updateSupervisor(root, record.id, { integration: { ...record.integration, applied: patches.map(patch => patch.hash) } });
        const postChecks = runChecks(settings.verifyCommands, cwd, env);
        if (postChecks.some(check => !check.ok)) {
          const cleanup = cleanupFanoutTasks(outcome.tasks, env);
          const reasons = postChecks.filter(check => !check.ok).map(check => `post-integration check failed: ${check.command.join(' ')} (exit ${check.code})`);
          record = finishSupervisor(root, record.id, 'failed', { errorMessage: reasons.join('\n'), checks: postChecks, integration: record.integration, cleanup, parallel: outcome.tasks });
          return record;
        }
      }
      const cleanup = cleanupFanoutTasks(outcome.tasks, env);
      record = finishSupervisor(root, record.id, 'completed', {
        integrated: settings.integrate,
        taskCount: outcome.tasks.length,
        summary: `Supervisor completed ${outcome.tasks.length} task(s) after ${attempt} iteration(s); evidence gate passed.`,
        cleanup,
        parallel: outcome.tasks,
        pid: null,
      });
      return record;
    }
    return finishSupervisor(root, record.id, 'failed', { errorMessage: 'supervisor exhausted its iteration budget' });
  } catch (error) {
    const cleanup = [...cleanupFanoutTasks(record.parallel ?? [], env), safeCleanup(record, env)].filter(Boolean);
    const current = readSupervisor(root, record.id);
    const status = current?.status === 'cancelled' ? 'cancelled' : 'failed';
    const final = finishSupervisor(root, record.id, status, { ...buildFailure(record, error), cleanup, parallel: record.parallel ?? null });
    return final;
  }
}

export function getSupervisor(root, id) {
  return readSupervisor(root, id);
}
