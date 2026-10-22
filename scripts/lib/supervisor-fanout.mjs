import { readJobFile } from './state.mjs';
import { cleanupWorkerWorktree } from './supervisor-git.mjs';
import { readSupervisor, updateSupervisor } from './supervisor-state.mjs';

export function pathsOverlap(left, right) {
  return left === right || (left.endsWith('/') && right.startsWith(left)) || (right.endsWith('/') && left.startsWith(right)) || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validatePlanOwnership(plan) {
  if (plan.steps.length < 2) return;
  const missing = plan.steps.filter(step => !step.files.length).map(step => step.id);
  if (missing.length) throw new Error(`parallel plan steps must declare owned files: ${missing.join(', ')}`);
  for (let i = 0; i < plan.steps.length; i++) {
    for (let j = i + 1; j < plan.steps.length; j++) {
      const overlap = plan.steps[i].files.some(left => plan.steps[j].files.some(right => pathsOverlap(left, right)));
      if (overlap) throw new Error(`plan steps ${plan.steps[i].id} and ${plan.steps[j].id} have overlapping file ownership`);
    }
  }
}

export async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

function updateParallelTask(root, supervisorId, taskId, patch) {
  const current = readSupervisor(root, supervisorId);
  if (!current) throw new Error(`supervisor record not found: ${supervisorId}`);
  const tasks = (current.parallel ?? []).map(task => task.id === taskId ? { ...task, ...patch } : task);
  const childJobIds = (patch.jobId || patch.reviewerJobId) ? [...new Set([...(current.childJobIds ?? []), patch.jobId ?? patch.reviewerJobId])] : current.childJobIds;
  return updateSupervisor(root, supervisorId, { parallel: tasks, childJobIds });
}

async function runFanoutTask({ root, cwd, objective, context, env, config, settings, options, plan, task, feedback, sessionId, supervisorId, attempt, deps }) {
  const { runExecutor, runChecks, captureWorkerPatch, patchPathFor, workerEvidence, reviewerEvidence, reviewerPrompt, stepPrompt, taskSchema, reviewSchema } = deps;
  let current = { ...task };
  let worker = current.worker;
  if (current.jobId) {
    const persisted = readJobFile(root, current.jobId);
    if (!persisted) throw new Error(`supervisor worker job is missing: ${current.jobId}`);
    if (persisted.status === 'queued' || persisted.status === 'running') throw new Error(`supervisor worker job is still active: ${persisted.id}; cancel it before resuming`);
    worker = worker ?? summarizeJob(persisted);
  }
  if (!worker) {
    const assignment = stepPrompt(objective, plan, current.step, feedback);
    const result = await runExecutor({
      root,
      cwd: current.worktree.worktreePath,
      env,
      config,
      role: current.step.role,
      kind: 'task',
      prompt: assignment,
      context,
      schemaPath: taskSchema,
      approveAll: options.approveAll === true,
      conversation: current.conversationId,
      sessionId,
      supervisorId,
      attempt,
      onJobCreated: job => { updateParallelTask(root, supervisorId, current.id, { jobId: job.id, status: 'running' }); },
    });
    worker = result.summary;
    current = { ...current, ...updateParallelTask(root, supervisorId, current.id, { jobId: result.job?.id ?? null, conversationId: worker.conversationId, worker, status: worker.status })?.parallel?.find(item => item.id === current.id) };
  }
  current.worker = worker;
  current.conversationId = worker?.conversationId ?? current.conversationId;
  current = { ...current, ...updateParallelTask(root, supervisorId, current.id, { worker, conversationId: current.conversationId, status: worker.status })?.parallel?.find(item => item.id === current.id) };
  if (!current.patch) {
    const patch = captureWorkerPatch(current.worktree.worktreePath, { baseCommit: current.worktree.baseCommit, patchFile: patchPathFor(root, `${supervisorId}-${attempt}-${current.id}`), env });
    current = { ...current, ...updateParallelTask(root, supervisorId, current.id, { patch })?.parallel?.find(item => item.id === current.id) };
  }
  if (!current.patch.empty && current.worker.status === 'completed' && !current.reviewer) {
    const checks = current.checks ?? runChecks(settings.verifyCommands, current.worktree.worktreePath, env);
    current = { ...current, ...updateParallelTask(root, supervisorId, current.id, { checks })?.parallel?.find(item => item.id === current.id) };
    const reviewed = await runExecutor({
      root,
      cwd: current.worktree.worktreePath,
      env,
      config,
      role: settings.reviewerRole,
      kind: 'review',
      prompt: reviewerPrompt(objective, current.worker, current.patch, checks),
      context,
      schemaPath: reviewSchema,
      approveAll: false,
      sessionId,
      supervisorId,
      attempt,
      onJobCreated: job => { updateParallelTask(root, supervisorId, current.id, { reviewerJobId: job.id }); },
    });
    current = { ...current, ...updateParallelTask(root, supervisorId, current.id, { reviewerJobId: reviewed.job?.id ?? null, reviewer: reviewed.summary })?.parallel?.find(item => item.id === current.id) };
  }
  const workerCheck = workerEvidence(current.worker);
  const review = reviewerEvidence(current.reviewer);
  const checks = current.checks ?? [];
  const ownershipViolations = current.step.files.length
    ? current.patch.changedFiles.filter(file => !current.step.files.some(owned => pathsOverlap(owned, file)))
    : [];
  const reasons = [];
  if (current.worker.status !== 'completed') reasons.push(`worker ${current.worker.status}: ${current.worker.error ?? 'no result'}`);
  if (!workerCheck.accepted) reasons.push(workerCheck.reason);
  if (ownershipViolations.length) reasons.push(`worker edited paths outside its ownership: ${ownershipViolations.join(', ')}`);
  if (current.patch.empty) reasons.push('worker produced no Git changes');
  if (current.worker.status === 'completed' && !current.patch.empty && !current.reviewer) reasons.push('reviewer was not completed');
  if (current.reviewer && current.reviewer.status !== 'completed') reasons.push(`reviewer ${current.reviewer.status}: ${current.reviewer.error ?? 'no evidence'}`);
  if (current.reviewer?.status === 'completed' && !review.accepted) reasons.push(review.reason);
  for (const check of checks) if (!check.ok) reasons.push(`check failed: ${check.command.join(' ')} (exit ${check.code})`);
  const evidence = { accepted: reasons.length === 0, reasons, reviewerVerdict: review.verdict };
  current = { ...current, ...updateParallelTask(root, supervisorId, current.id, { evidence, status: evidence.accepted ? 'accepted' : 'rejected' })?.parallel?.find(item => item.id === current.id) };
  return current;
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
    response: typeof (job?.result?.response ?? '') === 'string' ? job.result.response.slice(0, 32768) : '',
    structuredOutput: job?.result?.structuredOutput ?? null,
    changedFiles: Array.isArray(job?.result?.changedFiles) ? job.result.changedFiles.slice(0, 256) : [],
    exitCode: job?.exitCode ?? job?.result?.exitCode ?? null,
  };
}

export async function runFanoutAttempt({ root, cwd, env, config, settings, options, plan, record, attempt, sessionId, deps }) {
  const resumeAttempt = record.parallelAttempt === attempt && Array.isArray(record.parallel) && record.parallel.length === plan.steps.length;
  if (!resumeAttempt) {
    record = updateSupervisor(root, record.id, {
      phase: 'dispatching',
      attempt,
      parallelAttempt: attempt,
      parallel: plan.steps.map(step => ({ id: step.id, step, worktree: null, jobId: null, status: 'pending' })),
      workerJobId: null,
      workerConversationId: null,
      worker: null,
      patch: null,
      reviewerJobId: null,
      reviewer: null,
      checks: [],
      evidence: null,
      integration: null,
    });
  }
  let tasks = (record.parallel ?? []).map(item => ({ ...item, step: item.step ?? plan.steps.find(step => step.id === item.id) }));
  for (let task of tasks) {
    if (!task.worktree) {
      deps.requireCleanParent(cwd, { allowDirty: settings.allowDirty, env });
      const worktree = deps.createWorkerWorktree(cwd, { allowDirty: settings.allowDirty, env });
      task = { ...task, ...updateParallelTask(root, record.id, task.id, { worktree })?.parallel?.find(item => item.id === task.id) };
    }
  }
  record = readSupervisor(root, record.id);
  tasks = (record.parallel ?? []).map(item => ({ ...item, step: item.step ?? plan.steps.find(step => step.id === item.id) }));
  const results = await mapWithConcurrency(tasks, settings.maxWorkers, async task => {
    try {
      return await runFanoutTask({
        root,
        cwd,
        objective: record.request,
        context: record.context,
        env,
        config,
        settings,
        options,
        plan,
        task,
        feedback: record.feedback,
        sessionId,
        supervisorId: record.id,
        attempt,
        deps,
      });
    } catch (error) {
      const evidence = { accepted: false, reasons: [`task ${task.id} failed: ${error.message}`], reviewerVerdict: null };
      return { ...task, ...updateParallelTask(root, record.id, task.id, { status: 'failed', evidence })?.parallel?.find(item => item.id === task.id) };
    }
  });
  const reasons = results.flatMap(result => result.evidence.reasons.map(reason => `${result.id}: ${reason}`));
  const accepted = reasons.length === 0;
  const first = results[0] ?? {};
  record = updateSupervisor(root, record.id, {
    parallel: results,
    workerJobId: first.jobId ?? null,
    workerConversationId: first.conversationId ?? null,
    worker: first.worker ?? null,
    patch: first.patch ?? null,
    reviewerJobId: first.reviewerJobId ?? null,
    reviewer: first.reviewer ?? null,
    checks: first.checks ?? [],
    evidence: { accepted, reasons, taskCount: results.length },
    phase: accepted ? 'integrating' : 'revising',
  });
  return { record, tasks: results, accepted, reasons };
}

export function cleanupFanoutTasks(tasks, env) {
  return tasks.map(task => task.worktree ? { id: task.id, ...cleanupWorkerWorktree(task.worktree, { env }) } : { id: task.id, removed: false });
}
