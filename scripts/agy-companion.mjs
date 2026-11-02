import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { resolveApproveAll } from './lib/approval.mjs';
import { resolveDataRoot } from './lib/data-root.mjs';
import { loadPrompt, renderPrompt } from './lib/prompts.mjs';
import { workspaceSlug } from './lib/workspace.mjs';
import {
  isoNow,
  listJobs,
  mutateJob,
  readJobFile,
  resolveStateRoot,
  setConfig,
  getConfig,
} from './lib/state.mjs';
import { createJobRecord, createJobLogFile, appendLogLine, runTrackedJob } from './lib/tracked-jobs.mjs';
import { buildStatusSnapshot, resolveCancelableJob, resolveResultJob } from './lib/job-control.mjs';
import { renderJobDetail, renderStatusTable } from './lib/render.mjs';
import { get, list } from './lib/executors/registry.mjs';
import { loadDelegationConfig, resolveRoute } from './lib/delegation-config.mjs';
import { resolveSupervisor, finishSupervisor } from './lib/supervisor-state.mjs';
import { contextPrompt, contextReference, readTaskContext } from './lib/task-context.mjs';
import { appendTaskEvent } from './lib/task-events.mjs';
import { adviseTurns, advisorServer } from './lib/advisor.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function sessionIdFrom(env, legacy = false) {
  return env.AGENT_SESSION_ID ?? (legacy ? env.AGY_SESSION_ID ?? env.SESSION_ID : env.CODEX_THREAD_ID ?? env.CLAUDE_SESSION_ID ?? env.AGY_SESSION_ID ?? env.SESSION_ID) ?? null;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function write(out, text) {
  out.write(text + '\n');
}

export async function runMain(argv, { cwd = process.cwd(), env = process.env, out = process.stdout, err = process.stderr, legacy = true } = {}) {
  const dataRoot = resolveDataRoot(env);
  const [subcommand, ...rest] = argv;
  try {
    if (env.AGENT_DELEGATION_WORKER === '1' && ['task', 'plan', 'review', 'adversarial-review', 'gate'].includes(subcommand)) throw new Error('A delegated executor cannot recursively delegate another task');
    const { opts } = parseArgs(rest);
    if (!legacy && opts.unknown?.length) throw new Error(`Unknown flags: ${opts.unknown.join(', ')}`);
    cwd = resolve(cwd, opts.cwd ?? '.');
    if (opts['session-id']) env = { ...env, AGENT_SESSION_ID: opts['session-id'] };
    const ctx = { cwd, env, out, err, legacy, root: resolveStateRoot(dataRoot, workspaceSlug(cwd)), routing: legacy ? null : loadDelegationConfig(cwd, opts.config) };
    switch (subcommand) {
      case 'config':
        write(out, JSON.stringify(ctx.routing ?? loadDelegationConfig(cwd, opts.config), null, 2));
        return 0;
      case 'executors':
        write(out, JSON.stringify(list()));
        return 0;
      case 'setup':
        return await cmdSetup(rest, ctx);
      case 'task':
        return await cmdRunTask(rest, ctx, 'task');
      case 'gate':
        return await cmdGate(rest, ctx);
      case 'plan':
        return await cmdPlan(rest, ctx);
      case 'review':
      case 'adversarial-review':
        return await cmdReview(rest, ctx, subcommand);
      case 'status':
        return await cmdStatus(rest, ctx);
      case 'result':
        return await cmdResult(rest, ctx);
      case 'cancel':
        return await cmdCancel(rest, ctx);
      case 'task-resume-candidate':
        return await cmdTaskResumeCandidate(rest, ctx);
      case undefined:
      case 'help':
        write(err, usage());
        return subcommand === 'help' ? 0 : 2;
      default:
        write(err, `unknown subcommand: ${subcommand}\n\n${usage()}`);
        return 2;
    }
  } catch (e) {
    write(err, `error: ${e?.message ?? e}`);
    return 1;
  }
}

function usage() {
  return [
    'usage: agy-companion.mjs <subcommand> [options]',
    '',
    '  setup [--json] [--enable-review-gate|--disable-review-gate] [--enable-approve-all|--disable-approve-all]',
    '  task <prompt> [--resume|--fresh] [--model M] [--effort E] [--agent A] [--conversation ID] [--approve-all|--no-approve-all] [--timeout-ms N]',
    '  gate <prompt> [--json]',
    '  plan [<plan-file|text>] [--resume|--fresh]',
    '  review [--base REF] [--scope auto|working-tree|branch]',
    '  adversarial-review [<focus>] [--base REF] [--scope auto|working-tree|branch]',
    '  status [<job-id>] [--all] [--wait] [--timeout-ms N] [--json]',
    '  result <job-id|prefix> [--json]',
    '  cancel <job-id|prefix>',
    '  task-resume-candidate --json',
    '  config | executors',
    '  shared options: --executor opencode|codex|claude|agy --role NAME --config FILE --cwd DIR --session-id ID',
    '  task input: --prompt-file FILE (preserves quoting and newlines)',
  ].join('\n');
}

async function cmdSetup(argv, ctx) {
  const opts = executionOptions(argv, ctx);
  if (!ctx.legacy && Object.keys(opts).some(key => /^(enable|disable)-(approve-all|review-gate)$/.test(key))) throw new Error('Persistent approval and stop-gate settings belong to the legacy agy plugin; use --approve-all on an authorized task');
  if (opts['enable-review-gate'] && opts['disable-review-gate']) {
    throw new Error('cannot enable and disable the review gate at once');
  }
  if (opts['enable-approve-all'] && opts['disable-approve-all']) {
    throw new Error('cannot enable and disable approve-all at once');
  }
  if (opts['enable-review-gate']) setConfig(ctx.root, { stopReviewGate: true });
  if (opts['disable-review-gate']) setConfig(ctx.root, { stopReviewGate: false });
  if (opts['enable-approve-all']) setConfig(ctx.root, { approveAll: true });
  if (opts['disable-approve-all']) setConfig(ctx.root, { approveAll: false });
  const pre = await get(opts.executor, opts.integration).preflight({ cwd: ctx.cwd, env: ctx.env });
  const report = { ...pre, executor: opts.executor, ...(ctx.legacy ? { stopReviewGate: getConfig(ctx.root).stopReviewGate, approveAll: getConfig(ctx.root).approveAll === true } : {}) };
  if (opts.json) {
    write(ctx.out, JSON.stringify(report));
  } else {
    write(ctx.out, `${opts.executor} ready: ${report.ready}`);
    write(ctx.out, `  binary: ${report.binary}${report.version ? ` (v${report.version})` : ''}`);
    write(ctx.out, `  auth: ${report.auth}`);
    if (ctx.legacy) {
      write(ctx.out, `  stop-review-gate: ${report.stopReviewGate}`);
      write(ctx.out, `  approve-all: ${report.approveAll} (task/plan jobs auto-approve agy tools)`);
    }
    if (report.hint) write(ctx.out, `  hint: ${report.hint}`);
  }
  return report.ready ? 0 : 1;
}

function executionOptions(argv, ctx) {
  const { opts } = parseArgs(argv);
  if (!ctx.legacy && opts.resume && (opts.fresh || opts.conversation)) throw new Error('--resume cannot be combined with --fresh or --conversation');
  if (!ctx.legacy && opts.fresh && opts.conversation) throw new Error('--fresh cannot be combined with --conversation');
  const resolved = ctx.legacy ? { ...opts, executor: opts.executor ?? 'agy' } : resolveRoute(ctx.routing, opts);
  if (resolved.transport === 'native') throw new Error(`Role ${opts.role} uses native ${resolved.executor} agent ${resolved.nativeAgent}. Dispatch it through the host; use --executor ${resolved.executor} for an explicit CLI override.`);
  get(resolved.executor, resolved.integration);
  if (resolved['timeout-ms'] !== undefined && (!Number.isSafeInteger(Number(resolved['timeout-ms'])) || Number(resolved['timeout-ms']) <= 0 || Number(resolved['timeout-ms']) > 2_147_000_000)) throw new Error('--timeout-ms must be a positive integer below 2147000001');
  return resolved;
}

function runOptions(opts, ctx, extra = {}) {
  return {
    integration: opts.integration ?? 'cli',
    stateRoot: ctx.root,
    model: opts.model,
    effort: opts.effort,
    agent: opts.agent,
    advisor: opts.advisor,
    readOnly: opts.readOnly === true,
    conversation: extra.conversation ?? opts.conversation ?? null,
    approveAll: ctx.legacy ? resolveApproveAll({
      explicit: opts['approve-all'],
      config: getConfig(ctx.root).approveAll === true,
      cwd: ctx.cwd,
      env: ctx.env,
    }) : opts['approve-all'] === true && !opts.readOnly,
    jsonSchema: extra.schemaPath ?? opts['json-schema'] ?? null,
    outputFormat: 'stream-json',
    timeoutMs: toNumber(opts['timeout-ms'], undefined),
  };
}

function findResumeCandidate(root, sessionId, executor = 'agy', role, integration = 'cli') {
  return (
    listJobs(root).find((j) => j.executor === executor && (j.integration ?? 'cli') === integration && (!role || j.role === role) && !['queued', 'running'].includes(j.status) && (j.kind === 'task' || j.kind === 'plan') && j.conversationId && j.sessionId === sessionId) ?? null
  );
}

function buildProgressHandlers(ctx, job, progress) {
  return {
    onTaskEvent: event => {
      progress.event(event.type, event.data ?? {});
      if (event.type === 'session.started') progress.update({ conversationId: event.data.conversationId });
    },
    onProgress: (e) => {
      if (e.type === 'spawn') progress.update({ pid: e.pid, processIdentity: { pid: e.pid, binary: e.binary ?? 'unknown', startedAt: isoNow() } });
      if (e.type === 'phase') progress.setPhase(e.phase);
      if (e.type === 'tool') progress.event('tool.started', { name: e.name ?? 'working' });
      if (e.type === 'subagent-start') {
        progress.log(`subagent: ${e.name} started (${e.count} active)`);
      }
      if (e.type === 'subagent-done') {
        progress.log(`subagent: ${e.name} ${e.state.toLowerCase()}`);
      }
      if (e.type === 'tool') {
        // Don't double-log subagent tools since we handle them above
        const isSubagentTool = ['invoke_subagent', 'define_subagent', 'manage_subagents'].includes(e.name);
        if (!isSubagentTool) {
          progress.log(`tool: ${e.name}`);
        }
      }
      if (e.type === 'tool-error') progress.log(`tool error: ${e.message}`);
    },
    onStdoutLine: (text) => appendLogLine(ctx.root, job, `out: ${text.trimEnd()}`),
    onStderrLine: (text) => appendLogLine(ctx.root, job, `err: ${text.trimEnd()}`),
  };
}

export async function runForeground(ctx, job, opts, extra = {}) {
  if (!ctx.legacy && opts.instructions) job.request = `${opts.instructions}\n\nAssignment:\n${job.request}`;
  const executor = get(job.executor, opts.integration);
  const options = runOptions(opts, ctx, extra);
  Object.assign(job, { role: opts.role ?? null, model: options.model ?? null, integration: options.integration, capabilities: executor.capabilities });
  if (opts['context-id']) {
    const snapshot = readTaskContext(ctx.root, opts['context-id'], opts['context-revision'] ? Number(opts['context-revision']) : null);
    job.context = contextReference(snapshot);
    job.request = `${contextPrompt(ctx.root, job.context)}\n\nAssignment:\n${job.request}`;
  }
  if (!job.logFile) createJobLogFile(ctx.root, job);
  const advisorRoute = ctx.legacy ? null : opts['advisor-route'] ?? null;
  if (advisorRoute && options.integration === 'cli') options.advisorServer = advisorServer(ctx.root, job.id);
  const final = await runTrackedJob({
    root: ctx.root,
    job,
    run: async (progress) => {
      const handlers = buildProgressHandlers(ctx, job, progress);
      const turn = async (prompt, conversation) => {
        const result = await executor.runTask(
          { job, prompt, options: conversation ? { ...options, conversation } : options, ...handlers },
          { cwd: job.workspaceRoot ?? ctx.cwd, env: ctx.env }
        );
        progress.update({ conversationId: result.conversationId });
        return result;
      };
      const result = await turn(job.request);
      if (!advisorRoute) return result;
      return adviseTurns({ root: ctx.root, job, route: advisorRoute, rounds: opts['advisor-rounds'] ?? 2, result, resume: turn, env: ctx.env,
        isCancelled: () => readJobFile(ctx.root, job.id)?.status === 'cancelled' });
    },
  });
  const res = final.result ?? {};
  const ok = final.status === 'completed';
  if (opts.json) {
    write(ctx.out, JSON.stringify({ ...res, status: final.status, error: res.error ?? final.errorMessage, job: { id: final.id, executor: final.executor, integration: final.integration ?? 'cli', role: final.role ?? null, status: final.status, conversationId: final.conversationId, context: final.context ?? null, capabilities: final.capabilities } }));
    return ok ? 0 : 1;
  }
  if (ok) {
    if (res.response) ctx.out.write(res.response);
    if (res.notice) {
      write(ctx.err, `notice: ${res.notice}`);
      if (!res.response) {
        write(ctx.err, `${job.executor} produced no output (tool permissions were denied in headless mode).`);
        const softHint = executor.permissionDeniedHint?.(res, { jobClass: job.jobClass, approveAll: options.approveAll });
        if (softHint) write(ctx.err, `hint: ${softHint}`);
      }
    }
    if (!res.response && !res.notice) write(ctx.err, `${job.executor} produced no output.`);
    return 0;
  }
  const reason = final.errorMessage ?? res.error ?? 'unknown error';
  write(ctx.err, `${job.executor} ${job.kind} failed (${res.agyStatus ?? final.status}): ${reason}`);
  const hint = executor.permissionDeniedHint?.(res, { jobClass: job.jobClass, approveAll: options.approveAll });
  if (hint) write(ctx.err, `hint: ${hint}`);
  if (res.notice) write(ctx.err, `notice: ${res.notice}`);
  return 1;
}

async function cmdRunTask(argv, ctx, kind) {
  const opts = executionOptions(argv, ctx);
  const { positionals } = parseArgs(argv);
  if (opts['prompt-file'] && positionals.length) throw new Error('Use a prompt or --prompt-file, not both');
  const prompt = opts['prompt-file'] ? readFileSync(resolve(ctx.cwd, opts['prompt-file']), 'utf8') : positionals.join(' ');
  if (!prompt) {
    write(ctx.err, 'task requires a prompt');
    return 2;
  }
  const sessionId = sessionIdFrom(ctx.env, ctx.legacy);
  let conversation = opts.conversation ?? null;
  if (opts.resume) {
    const candidate = findResumeCandidate(ctx.root, sessionId, opts.executor, opts.role, opts.integration);
    if (candidate?.conversationId) conversation = candidate.conversationId;
    else write(ctx.err, `note: no resumable ${kind} job found for this session; starting fresh`);
  }
  if (opts.fresh) conversation = null;
  const job = createJobRecord({ executor: opts.executor, kind, request: prompt, sessionId, workspaceRoot: ctx.cwd });
  // Background mode now handled by Claude Code harness via run_in_background Bash calls
  // The --background flag should be stripped by the caller before reaching here
  if (opts.background) {
    write(ctx.err, 'error: --background must be handled by the caller (use run_in_background: true on Bash call)');
    return 2;
  }
  return runForeground(ctx, job, opts, { conversation });
}

async function cmdGate(argv, ctx) {
  const opts = executionOptions(argv, ctx);
  const { positionals } = parseArgs(argv);
  if (opts['prompt-file'] && positionals.length) throw new Error('Use --prompt-file or an inline prompt, not both');
  const prompt = opts['prompt-file'] ? readFileSync(resolve(ctx.cwd, opts['prompt-file']), 'utf8') : positionals.join(' ');
  if (!prompt) {
    write(ctx.err, 'gate requires a prompt');
    return 2;
  }
  const schemaPath = opts['json-schema'] ?? join(PLUGIN_ROOT, 'schemas', 'stop-gate.schema.json');
  const job = createJobRecord({ executor: opts.executor, kind: 'review', request: prompt, sessionId: sessionIdFrom(ctx.env, ctx.legacy), workspaceRoot: ctx.cwd });
  return runForeground(ctx, job, { ...opts, readOnly: true, 'approve-all': false }, { schemaPath });
}

function newestPlanFile(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
  if (!files.length) return null;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function cmdPlan(argv, ctx) {
  const opts = executionOptions(argv, ctx);
  const { positionals } = parseArgs(argv);
  let planText = null;
  if (positionals[0]) {
    const target = resolve(ctx.cwd, positionals[0]);
    if (existsSync(target) && statSync(target).isFile()) {
      planText = readFileSync(target, 'utf8');
    } else {
      planText = positionals.join(' ');
    }
  } else {
    const file = newestPlanFile(join(ctx.cwd, 'docs', 'superpowers', 'plans'));
    if (file) planText = readFileSync(file, 'utf8');
  }
  if (!planText || !planText.trim()) {
    write(ctx.err, 'plan: no plan file found (pass a path or inline plan text)');
    return 2;
  }
  const prompt = renderPrompt(loadPrompt('plan-execution', PLUGIN_ROOT), { PLAN_TEXT: planText });
  const sessionId = sessionIdFrom(ctx.env, ctx.legacy);
  let conversation = opts.conversation ?? null;
  if (opts.resume) {
    const candidate = findResumeCandidate(ctx.root, sessionId, opts.executor, opts.role, opts.integration);
    if (candidate?.conversationId) conversation = candidate.conversationId;
    else write(ctx.err, 'note: no resumable plan job found for this session; starting fresh');
  }
  if (opts.fresh) conversation = null;
  const job = createJobRecord({ executor: opts.executor, kind: 'plan', request: prompt, sessionId, workspaceRoot: ctx.cwd });
  // Background mode now handled by Claude Code harness via run_in_background Bash calls
  // The --background flag should be stripped by the caller before reaching here
  if (opts.background) {
    write(ctx.err, 'error: --background must be handled by the caller (use run_in_background: true on Bash call)');
    return 2;
  }
  return runForeground(ctx, job, opts, { conversation });
}

async function cmdReview(argv, ctx, kind) {
  const opts = executionOptions(argv, ctx);
  const { positionals } = parseArgs(argv);
  const collected = get(opts.executor).collectContext({ cwd: ctx.cwd, jobClass: 'review', base: opts.base, scope: opts.scope });
  const focus = positionals.join(' ');
  const prompt = renderPrompt(loadPrompt(kind, PLUGIN_ROOT), {
    TARGET_LABEL: focus || 'current changes',
    USER_FOCUS: focus,
    REVIEW_COLLECTION_GUIDANCE: collected.changedFilesHint.length ? `Files changed: ${collected.changedFilesHint.join(', ')}` : '',
    REVIEW_INPUT: collected.promptExtra ?? '',
  });
  const sessionId = sessionIdFrom(ctx.env, ctx.legacy);
  const job = createJobRecord({ executor: opts.executor, kind, request: prompt, sessionId, workspaceRoot: ctx.cwd });
  const schemaPath = join(PLUGIN_ROOT, 'schemas', 'review-output.schema.json');
  // Background mode now handled by Claude Code harness via run_in_background Bash calls
  // The --background flag should be stripped by the caller before reaching here
  if (opts.background) {
    write(ctx.err, 'error: --background must be handled by the caller (use run_in_background: true on Bash call)');
    return 2;
  }
  return runForeground(ctx, job, opts, { schemaPath });
}

async function cmdStatus(argv, ctx) {
  const { opts, positionals } = parseArgs(argv);
  const id = positionals[0];
  const sessionId = sessionIdFrom(ctx.env, ctx.legacy);
  if (opts.wait) {
    if (!id) {
      write(ctx.err, 'status --wait requires a job id');
      return 2;
    }
    const deadline = Date.now() + toNumber(opts['timeout-ms'], 60_000);
    let job = resolveResultJob(listJobs(ctx.root), id);
    while (!TERMINAL_STATUSES.has(job.status) && Date.now() < deadline) {
      await sleep(750);
      job = readJobFile(ctx.root, job.id) ?? job;
    }
    if (!TERMINAL_STATUSES.has(job.status)) {
      write(ctx.err, `job ${job.id} still ${job.status} after ${toNumber(opts['timeout-ms'], 60_000)}ms`);
      return 1;
    }
    if (opts.json) write(ctx.out, JSON.stringify(job));
    else write(ctx.out, renderJobDetail(job));
    return 0;
  }
  if (id) {
    const job = resolveResultJob(listJobs(ctx.root), id);
    if (opts.json) write(ctx.out, JSON.stringify(job));
    else write(ctx.out, renderJobDetail(job));
    return 0;
  }
  const snapshot = buildStatusSnapshot({ jobs: listJobs(ctx.root), sessionId, all: Boolean(opts.all) });
  if (opts.json) write(ctx.out, JSON.stringify(snapshot));
  else write(ctx.out, renderStatusTable(snapshot));
  return 0;
}

async function cmdResult(argv, ctx) {
  const { opts, positionals } = parseArgs(argv);
  const id = positionals[0];
  if (!id) {
    write(ctx.err, 'result requires a job id or prefix');
    return 2;
  }
  const job = resolveResultJob(listJobs(ctx.root), id);
  if (opts.json) write(ctx.out, JSON.stringify(job));
  else write(ctx.out, renderJobDetail(job));
  return 0;
}

async function cancelTrackedJob(root, job) {
  if (!job.pid) throw new Error(`job ${job.id} has no pid to cancel`);
  if (!job.processIdentity || job.processIdentity.pid !== job.pid) throw new Error(`job ${job.id} has no verifiable process identity; refusing to signal pid ${job.pid}`);
  await get(job.executor).cancel(job.pid);
}

async function cmdCancel(argv, ctx) {
  const { positionals } = parseArgs(argv);
  const id = positionals[0];
  if (!id) {
    write(ctx.err, 'cancel requires a job or supervisor id or prefix');
    return 2;
  }
  const jobs = listJobs(ctx.root);
  const matchingJobs = jobs.filter(job => job.id === id || job.id.startsWith(id));
  if (matchingJobs.length) {
    const job = resolveCancelableJob(jobs, id);
    mutateJob(ctx.root, job.id, current => current.status === 'cancelled' ? current : { ...current, status: 'cancelled', phase: 'cancelled', cancelledAt: isoNow() });
    appendTaskEvent(ctx.root, job.id, 'task.cancelled', { context: job.context ?? null });
    await cancelTrackedJob(ctx.root, job);
    write(ctx.out, `Cancelled job ${job.id}`);
    return 0;
  }
  const supervisor = resolveSupervisor(ctx.root, id);
  if (!supervisor) throw new Error(`no running or queued job or supervisor found: ${id}`);
  if (supervisor.status === 'cancelled' || supervisor.status === 'completed' || supervisor.status === 'failed') {
    write(ctx.out, `Supervisor ${supervisor.id} is already ${supervisor.status}`);
    return 0;
  }
  finishSupervisor(ctx.root, supervisor.id, 'cancelled', { pid: null });
  for (const childId of supervisor.childJobIds ?? []) {
    const child = readJobFile(ctx.root, childId);
    if (!child || !['queued', 'running'].includes(child.status)) continue;
    mutateJob(ctx.root, child.id, current => current.status === 'cancelled' ? current : { ...current, status: 'cancelled', phase: 'cancelled', cancelledAt: isoNow() });
    appendTaskEvent(ctx.root, child.id, 'task.cancelled', { context: child.context ?? null });
    if (child.processIdentity?.pid === child.pid) {
      try { await get(child.executor).cancel(child.pid); } catch {}
    }
  }
  if (supervisor.pid && supervisor.processIdentity?.pid === supervisor.pid) await get('agy').cancel(supervisor.pid);
  write(ctx.out, `Cancelled supervisor ${supervisor.id}`);
  return 0;
}

async function cmdTaskResumeCandidate(argv, ctx) {
  const opts = executionOptions(argv, ctx);
  const candidate = findResumeCandidate(ctx.root, sessionIdFrom(ctx.env, ctx.legacy), opts.executor, opts.role, opts.integration);
  if (!candidate) {
    write(ctx.out, JSON.stringify({}));
    return 0;
  }
  write(
    ctx.out,
    JSON.stringify({ id: candidate.id, kind: candidate.kind, conversationId: candidate.conversationId, title: candidate.title, updatedAt: candidate.updatedAt })
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runMain(process.argv.slice(2));
}
