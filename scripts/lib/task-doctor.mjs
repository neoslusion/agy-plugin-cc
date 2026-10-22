import { resolve } from 'node:path';
import { parseArgs } from './args.mjs';
import { taskRoot, taskSession } from './task-api.mjs';
import { visibleTasks, selectTask, TERMINAL_TASKS } from './task-view.mjs';
import { mutateJob, isoNow } from './state.mjs';
import { appendTaskEvent } from './task-events.mjs';

export function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
}

export function diagnoseTask(task, records, probe = processState) {
  const processes = [...new Set([task.pid, task.workerPid].filter(pid => Number.isSafeInteger(pid) && pid > 0))]
    .map(pid => ({ pid, state: probe(pid) }));
  const activeChildren = records.filter(child => child.supervisorId === task.id && !TERMINAL_TASKS.has(child.status));
  const terminal = TERMINAL_TASKS.has(task.status);
  const ownerKnown = task.kind === 'run' || (Number.isSafeInteger(task.workerPid) && task.workerPid > 0);
  const stale = !terminal && ownerKnown && processes.length > 0 && processes.every(item => item.state === 'absent');
  const finding = terminal ? 'terminal' : stale ? 'processes_exited' : processes.some(item => item.state === 'present') ? 'process_present' : 'process_unknown';
  const actions = terminal ? task.kind === 'run' ? ['Read the saved result and evidence.'] : ['Read the saved result; follow-up creates a new task.']
    : stale ? task.kind === 'run'
      ? [`Run run --resume --supervisor-id ${task.id} after resolving active child tasks.`, 'Inspect the checkpoint, worktree and checks before integration.']
      : [`Run doctor ${task.id} --repair to record the interrupted attempt.`, `Inspect changed files, then follow-up ${task.id}${task.conversationId ? '' : ' --fresh'} with the remaining assignment.`]
    : ['Inspect tasks, events and the log. Process presence does not prove ownership or progress; no recovery is attempted.'];
  return { taskId: task.id, kind: task.kind, status: task.status, finding, stale, processes, ownerKnown, activeChildTaskIds: activeChildren.map(child => child.id), actions };
}

export async function runTaskDoctor(argv, context = {}) {
  const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
  try {
    const { opts, positionals } = parseArgs(argv, { extraBool: ['repair'] });
    for (const key of Object.keys(opts)) if (!['cwd', 'session-id', 'json', 'all', 'repair'].includes(key)) throw new Error(`--${key} is not supported by doctor`);
    if (positionals.length > 1) throw new Error('doctor accepts at most one task ID');
    if (opts.repair && (opts.all || !positionals.length)) throw new Error('--repair requires one owned task ID and cannot use --all');
    if (env.AGENT_DELEGATION_WORKER === '1' && opts.repair) throw new Error('A delegated worker cannot repair parent tasks');
    const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
    const root = taskRoot(cwd, env), records = visibleTasks(root, opts['session-id'] ?? taskSession(env), opts.all === true);
    const selected = positionals.length ? [selectTask(root, records, positionals[0]).task] : records;
    const reports = selected.map(task => diagnoseTask(task, records, context.processProbe));
    if (opts.repair) {
      const task = selected[0], report = reports[0];
      if (!report.stale) throw new Error(`Task ${task.id} has no confirmed exited process; state is unchanged`);
      if (task.kind === 'run') {
        throw new Error(`Supervisor checkpoints are already resumable; use run --resume --supervisor-id ${task.id} after resolving active children`);
      } else {
        let repaired = false;
        mutateJob(root, task.id, current => {
          if (!diagnoseTask(current, records, context.processProbe).stale) return current;
          repaired = true;
          return { ...current, status: 'failed', phase: 'interrupted', completedAt: isoNow(), exitCode: 1,
            errorMessage: 'Recorded task processes exited without a terminal result. Inspect changes before continuing.',
            recovery: { reason: 'processes_exited', diagnosedAt: isoNow() } };
        });
        if (!repaired) throw new Error('Task changed during diagnosis; state is unchanged');
        appendTaskEvent(root, task.id, 'task.failed', { reason: 'processes_exited', error: 'Task interrupted; inspect changes before continuing.' });
      }
      report.repaired = true;
    }
    out.write(opts.json ? JSON.stringify({ tasks: reports, count: reports.length }) + '\n'
      : reports.map(report => `${report.taskId}: ${report.finding}${report.repaired ? ' (repaired)' : ''}\n${report.actions.map(action => `  ${action}`).join('\n')}`).join('\n') + '\n');
    return 0;
  } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
}
