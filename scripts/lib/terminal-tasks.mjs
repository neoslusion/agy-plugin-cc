import { resolve } from 'node:path';
import { parseArgs } from './args.mjs';
import { taskRoot, taskSession } from './task-api.mjs';
import { readTaskEvents } from './task-events.mjs';
import { visibleTasks, selectTask, waitForTask, waitForWake, renderTaskList, renderTaskSnapshot } from './task-view.mjs';

export function waitBudget(value, fallback = 60000) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 60000) throw new Error('Wait timeout must be an integer from 0 to 60000ms');
  return number;
}

export async function runTerminalTasks(command, argv, context = {}) {
  const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
  try {
    const { opts, positionals } = parseArgs(argv, { extraBool: command === 'wait' ? ['wake'] : [] });
    const allowed = ['cwd', 'session-id', 'json', ...(command === 'tasks' ? ['all'] : ['timeout-ms']), ...(command === 'watch' ? ['after'] : []), ...(command === 'wait' ? ['wake'] : [])];
    for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw new Error(`--${key} is not supported by ${command}`);
    if (positionals.length > 1 || (command === 'wait' && !positionals.length)) throw new Error(`${command} ${command === 'wait' ? 'requires one' : 'accepts at most one'} task ID`);
    const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
    const root = taskRoot(cwd, env), sessionId = opts['session-id'] ?? taskSession(env);
    const records = visibleTasks(root, sessionId, opts.all === true);
    if (command === 'tasks') {
      const snapshot = positionals.length ? selectTask(root, records, positionals[0]) : { tasks: records.map(task => selectTask(root, records, task.id)), count: records.length, sessionId };
      out.write((opts.json ? JSON.stringify(snapshot) : positionals.length ? renderTaskSnapshot(snapshot) : renderTaskList(root, records)) + '\n');
      return 0;
    }
    if (command === 'wait') {
      if (opts.wake && opts['timeout-ms'] !== undefined) throw new Error('--wake waits without a budget; omit --timeout-ms');
      const snapshot = opts.wake ? await waitForWake(root, sessionId, positionals[0]) : await waitForTask(root, sessionId, positionals[0], { timeoutMs: waitBudget(opts['timeout-ms']) });
      out.write((opts.json ? JSON.stringify(snapshot) : renderTaskSnapshot(snapshot)) + '\n');
      return snapshot.waitTimedOut || snapshot.status === 'completed' ? 0 : 1;
    }
    if (opts.after !== undefined && !positionals.length) throw new Error('--after requires a single task ID');
    const after = Number(opts.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative integer');
    const taskId = positionals.length ? selectTask(root, records, positionals[0]).taskId : null;
    const timeoutMs = waitBudget(opts['timeout-ms']), deadline = Date.now() + timeoutMs;
    const cursors = {}, known = new Set(records.map(task => task.id));
    let stopped = false, ended = false;
    const stop = () => { stopped = true; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      do {
        const current = visibleTasks(root, sessionId);
        const selected = taskId ? [selectTask(root, current, taskId)] : current.map(task => selectTask(root, current, task.id));
        let backlog = false;
        for (const snapshot of selected) {
          const id = snapshot.taskId;
          if (!known.has(id)) { known.add(id); out.write(opts.json ? JSON.stringify({ type: 'task.discovered', taskId: id }) + '\n' : `New task ${id}\n`); }
          const pending = readTaskEvents(root, id, cursors[id] ?? after), events = pending.slice(0, 128);
          backlog ||= pending.length > events.length;
          for (const event of events) {
            out.write(opts.json ? JSON.stringify({ type: 'event', event }) + '\n' : `${event.createdAt} ${id} #${event.sequence} ${event.type} ${String(event.data.phase ?? event.data.name ?? event.data.error ?? event.data.summary ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 160)}\n`);
            cursors[id] = event.sequence;
          }
          cursors[id] ??= after;
        }
        ended = selected.length > 0 && selected.every(snapshot => snapshot.ready && snapshot.terminalEventSequence) && !backlog;
        if (ended || stopped || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(backlog ? 10 : 250, Math.max(0, deadline - Date.now()))));
      } while (true);
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    out.write(opts.json ? JSON.stringify({ type: 'watch.end', watchTimedOut: !ended && !stopped, stopped, cursors }) + '\n' : `Watch ${stopped ? 'stopped' : ended ? 'complete' : 'timed out'}; tasks are unchanged.\n`);
    return stopped ? 130 : 0;
  } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
}
