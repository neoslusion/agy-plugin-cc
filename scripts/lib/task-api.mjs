import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './args.mjs';
import { resolveStateRoot, listJobs } from './state.mjs';
import { resolveDataRoot } from './data-root.mjs';
import { workspaceSlug } from './workspace.mjs';
import { listSupervisors } from './supervisor-state.mjs';
import { resolveResultJob } from './job-control.mjs';
import { createTaskContext, readTaskContext, reviseTaskContext } from './task-context.mjs';
import { pendingNotifications, readTaskEvents, waitTaskEvents } from './task-events.mjs';
import { queueTaskControl } from './task-controls.mjs';
import { visibleTasks } from './task-view.mjs';

export const TASK_COMMANDS = ['context-create', 'context-show', 'context-update', 'events', 'notifications', 'steer', 'interrupt'];
export function taskSession(env) {
  return env.AGENT_SESSION_ID ?? env.CODEX_THREAD_ID ?? env.CLAUDE_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID ?? env.AGY_SESSION_ID ?? env.SESSION_ID ?? null;
}
export function dataBase(env) {
  return resolveDataRoot(env);
}
export function taskRoot(cwd, env) {
  return resolveStateRoot(dataBase(env), workspaceSlug(cwd));
}
function integer(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new Error(`${name} must be an integer between 0 and ${max}`);
  return number;
}
export async function runTaskApi(command, argv, context = {}) {
  const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
  try {
    const { opts, positionals } = parseArgs(argv);
    const extras = { 'context-create': ['context-file'], 'context-show': ['context-revision'], 'context-update': ['context-file', 'expected-revision'], events: ['after', 'wait', 'timeout-ms'], notifications: ['ack'], steer: ['message-file'], interrupt: [] }[command];
    for (const key of Object.keys(opts)) if (!['cwd', 'session-id', 'json', ...extras].includes(key)) throw new Error(`--${key} is not supported by ${command}`);
    if (env.AGENT_DELEGATION_WORKER === '1' && !['context-show', 'events'].includes(command)) throw new Error('A delegated worker cannot mutate parent context, controls, or notification delivery');
    const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
    const root = taskRoot(cwd, env), sessionId = opts['session-id'] ?? taskSession(env);
    const fileJson = () => {
      if (!opts['context-file']) throw new Error(`${command} requires --context-file FILE`);
      const content = readFileSync(resolve(cwd, opts['context-file']), 'utf8');
      if (Buffer.byteLength(content) > 128 * 1024) throw new Error('Context file exceeds 128 KiB');
      return JSON.parse(content);
    };
    let result;
    if (command === 'context-create') {
      if (positionals.length) throw new Error('context-create takes no positional arguments');
      result = createTaskContext(root, fileJson());
    } else if (command === 'context-show' || command === 'context-update') {
      if (positionals.length !== 1) throw new Error(`${command} requires one context ID`);
      result = command === 'context-show' ? readTaskContext(root, positionals[0], integer(opts['context-revision'], null, 'context revision')) : reviseTaskContext(root, positionals[0], fileJson(), integer(opts['expected-revision'], null, 'expected revision'));
    } else if (command === 'notifications') {
      if (positionals.length || !sessionId) throw new Error('notifications requires a parent session ID (AGENT_SESSION_ID or --session-id)');
      result = pendingNotifications(root, [...listJobs(root), ...listSupervisors(root)], sessionId, opts.ack === true);
    } else {
      if (!positionals[0]) throw new Error(`${command} requires a task ID`);
      const job = resolveResultJob(visibleTasks(root, sessionId), positionals[0]);
      if (command === 'events') {
        if (positionals.length !== 1) throw new Error('events requires one task ID');
        const after = integer(opts.after, 0, 'event cursor');
        result = opts.wait ? await waitTaskEvents(root, job.id, after, integer(opts['timeout-ms'], 60000, 'wait timeout', 60000)) : { events: readTaskEvents(root, job.id, after) };
      } else {
        if (!sessionId) throw new Error(`${command} requires a parent session ID`);
        if (command === 'interrupt' && positionals.length !== 1) throw new Error('interrupt requires one task ID');
        if (opts['message-file'] && positionals.length > 1) throw new Error('Use --message-file or an inline message, not both');
        const message = opts['message-file'] ? readFileSync(resolve(cwd, opts['message-file']), 'utf8') : positionals.slice(1).join(' ');
        result = queueTaskControl(root, job, job.sessionId, command, message);
      }
    }
    out.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
}
