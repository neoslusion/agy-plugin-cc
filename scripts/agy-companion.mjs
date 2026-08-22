import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/args.mjs';
import { resolveApproveAll } from './lib/approval.mjs';
import { loadPrompt, renderPrompt } from './lib/prompts.mjs';
import { workspaceSlug } from './lib/workspace.mjs';
import {
  isoNow,
  listJobs,
  readJobFile,
  resolveStateRoot,
  setConfig,
  getConfig,
  upsertJob,
} from './lib/state.mjs';
import { createJobRecord, createJobLogFile, appendLogLine, runTrackedJob } from './lib/tracked-jobs.mjs';
import { buildStatusSnapshot, resolveCancelableJob, resolveResultJob } from './lib/job-control.mjs';
import { renderJobDetail, renderStatusTable } from './lib/render.mjs';
import { get } from './lib/executors/registry.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function sessionIdFrom(env) {
  return env.AGY_SESSION_ID ?? env.SESSION_ID ?? null;
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

export async function runMain(argv, { cwd = process.cwd(), env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const dataRoot = env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'agy-companion');
  const ctx = { cwd, env, out, err, root: resolveStateRoot(dataRoot, workspaceSlug(cwd)) };
  const [subcommand, ...rest] = argv;
  try {
    switch (subcommand) {
      case 'setup':
        return await cmdSetup(rest, ctx);
      case 'task':
        return await cmdRunTask(rest, ctx, 'task');
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
    '  plan [<plan-file|text>] [--resume|--fresh]',
    '  review [--base REF] [--scope auto|working-tree|branch]',
    '  adversarial-review [<focus>] [--base REF] [--scope auto|working-tree|branch]',
    '  status [<job-id>] [--all] [--wait] [--timeout-ms N] [--json]',
    '  result <job-id|prefix> [--json]',
    '  cancel <job-id|prefix>',
    '  task-resume-candidate --json',
  ].join('\n');
}

async function cmdSetup(argv, ctx) {
  const { opts } = parseArgs(argv);
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
  const pre = get('agy').preflight({ cwd: ctx.cwd });
  const report = { ...pre, stopReviewGate: getConfig(ctx.root).stopReviewGate, approveAll: getConfig(ctx.root).approveAll === true };
  if (opts.json) {
    write(ctx.out, JSON.stringify(report));
  } else {
    write(ctx.out, `agy ready: ${report.ready}`);
    write(ctx.out, `  binary: ${report.binary}${report.version ? ` (v${report.version})` : ''}`);
    write(ctx.out, `  auth: ${report.auth}`);
    write(ctx.out, `  stop-review-gate: ${report.stopReviewGate}`);
    write(ctx.out, `  approve-all: ${report.approveAll} (task/plan jobs auto-approve agy tools)`);
    if (report.hint) write(ctx.out, `  hint: ${report.hint}`);
  }
  return report.ready ? 0 : 1;
}

function runOptions(opts, ctx, extra = {}) {
  return {
    model: opts.model,
    effort: opts.effort,
    agent: opts.agent,
    conversation: extra.conversation ?? opts.conversation ?? null,
    approveAll: resolveApproveAll({
      explicit: opts['approve-all'],
      config: getConfig(ctx.root).approveAll === true,
      cwd: ctx.cwd,
      env: ctx.env,
    }),
    jsonSchema: extra.schemaPath ?? opts['json-schema'] ?? null,
    outputFormat: 'stream-json',
    timeoutMs: toNumber(opts['timeout-ms'], undefined),
  };
}

function findResumeCandidate(root, sessionId) {
  return (
    listJobs(root).find((j) => (j.kind === 'task' || j.kind === 'plan') && j.conversationId && (!sessionId || j.sessionId === sessionId)) ?? null
  );
}

function buildProgressHandlers(ctx, job, progress) {
  return {
    onProgress: (e) => {
      if (e.type === 'phase') progress.setPhase(e.phase);
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

async function runForeground(ctx, job, opts, extra = {}) {
  createJobLogFile(ctx.root, job);
  const final = await runTrackedJob({
    root: ctx.root,
    job,
    run: async (progress) => {
      const handlers = buildProgressHandlers(ctx, job, progress);
      const result = await get('agy').runTask(
        { job, prompt: job.request, options: runOptions(opts, ctx, extra), ...handlers },
        { cwd: job.workspaceRoot ?? ctx.cwd }
      );
      progress.update({ conversationId: result.conversationId });
      return result;
    },
  });
  const res = final.result ?? {};
  const ok = res.status === 'completed';
  if (opts.json) {
    write(ctx.out, JSON.stringify({ job: { id: final.id, status: final.status, conversationId: final.conversationId }, ...res }));
    return ok ? 0 : 1;
  }
  if (ok) {
    if (res.response) ctx.out.write(res.response);
    if (res.notice) {
      write(ctx.err, `notice: ${res.notice}`);
      if (!res.response) {
        write(ctx.err, 'agy produced no output (tool permissions were denied in headless mode).');
        const softHint = get('agy').permissionDeniedHint?.(res, { jobClass: job.jobClass, approveAll: Boolean(opts['approve-all']) });
        if (softHint) write(ctx.err, `hint: ${softHint}`);
      }
    }
    if (!res.response && !res.notice) write(ctx.err, 'agy produced no output.');
    return 0;
  }
  const reason = final.errorMessage ?? res.error ?? 'unknown error';
  upsertJob(ctx.root, {
    ...final,
    status: res.status === 'cancelled' ? 'cancelled' : 'failed',
    phase: res.status === 'cancelled' ? 'cancelled' : 'failed',
    completedAt: isoNow(),
    exitCode: res.exitCode ?? 1,
    errorMessage: reason,
  });
  write(ctx.err, `agy ${job.kind} failed (${res.agyStatus ?? final.status}): ${reason}`);
  const hint = get('agy').permissionDeniedHint?.(res, { jobClass: job.jobClass, approveAll: Boolean(opts['approve-all']) });
  if (hint) write(ctx.err, `hint: ${hint}`);
  if (res.notice) write(ctx.err, `notice: ${res.notice}`);
  return 1;
}

async function cmdRunTask(argv, ctx, kind) {
  const { opts, positionals } = parseArgs(argv);
  const prompt = positionals.join(' ');
  if (!prompt) {
    write(ctx.err, 'task requires a prompt');
    return 2;
  }
  const sessionId = sessionIdFrom(ctx.env);
  let conversation = opts.conversation ?? null;
  if (opts.resume) {
    const candidate = findResumeCandidate(ctx.root, sessionId);
    if (candidate?.conversationId) conversation = candidate.conversationId;
    else write(ctx.err, `note: no resumable ${kind} job found for this session; starting fresh`);
  }
  if (opts.fresh) conversation = null;
  const job = createJobRecord({ executor: 'agy', kind, request: prompt, sessionId, workspaceRoot: ctx.cwd });
  // Background mode now handled by Claude Code harness via run_in_background Bash calls
  // The --background flag should be stripped by the caller before reaching here
  if (opts.background) {
    write(ctx.err, 'error: --background must be handled by the caller (use run_in_background: true on Bash call)');
    return 2;
  }
  return runForeground(ctx, job, opts, { conversation });
}

function newestPlanFile(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
  if (!files.length) return null;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function cmdPlan(argv, ctx) {
  const { opts, positionals } = parseArgs(argv);
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
  const sessionId = sessionIdFrom(ctx.env);
  let conversation = opts.conversation ?? null;
  if (opts.resume) {
    const candidate = findResumeCandidate(ctx.root, sessionId);
    if (candidate?.conversationId) conversation = candidate.conversationId;
    else write(ctx.err, 'note: no resumable plan job found for this session; starting fresh');
  }
  if (opts.fresh) conversation = null;
  const job = createJobRecord({ executor: 'agy', kind: 'plan', request: prompt, sessionId, workspaceRoot: ctx.cwd });
  // Background mode now handled by Claude Code harness via run_in_background Bash calls
  // The --background flag should be stripped by the caller before reaching here
  if (opts.background) {
    write(ctx.err, 'error: --background must be handled by the caller (use run_in_background: true on Bash call)');
    return 2;
  }
  return runForeground(ctx, job, opts, { conversation });
}

async function cmdReview(argv, ctx, kind) {
  const { opts, positionals } = parseArgs(argv);
  const collected = get('agy').collectContext({ cwd: ctx.cwd, jobClass: 'review', base: opts.base, scope: opts.scope });
  const focus = positionals.join(' ');
  const prompt = renderPrompt(loadPrompt(kind, PLUGIN_ROOT), {
    TARGET_LABEL: focus || 'current changes',
    USER_FOCUS: focus,
    REVIEW_COLLECTION_GUIDANCE: collected.changedFilesHint.length ? `Files changed: ${collected.changedFilesHint.join(', ')}` : '',
    REVIEW_INPUT: collected.promptExtra ?? '',
  });
  const sessionId = sessionIdFrom(ctx.env);
  const job = createJobRecord({ executor: 'agy', kind, request: prompt, sessionId, workspaceRoot: ctx.cwd });
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
  const sessionId = sessionIdFrom(ctx.env);
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

async function cmdCancel(argv, ctx) {
  const { positionals } = parseArgs(argv);
  const id = positionals[0];
  if (!id) {
    write(ctx.err, 'cancel requires a job id or prefix');
    return 2;
  }
  const job = resolveCancelableJob(listJobs(ctx.root), id);
  const executor = get(job.executor);
  await executor.cancel(job.pid);
  upsertJob(ctx.root, { ...job, status: 'cancelled', phase: 'cancelled', cancelledAt: isoNow() });
  write(ctx.out, `Cancelled job ${job.id}`);
  return 0;
}

async function cmdTaskResumeCandidate(argv, ctx) {
  const candidate = findResumeCandidate(ctx.root, sessionIdFrom(ctx.env));
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
