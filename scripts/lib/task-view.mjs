import { listJobs } from './state.mjs';
import { listSupervisors } from './supervisor-state.mjs';
import { readTaskEvents } from './task-events.mjs';
import { resolveResultJob } from './job-control.mjs';

export const TERMINAL_TASKS = new Set(['completed', 'failed', 'cancelled']);

export function visibleTasks(root, sessionId, all = false) {
  if (!sessionId && !all) throw new Error('Use --session-id ID or --all to select terminal tasks');
  const records = [...listJobs(root), ...listSupervisors(root)];
  const parents = new Set(records.filter(task => task.kind === 'run' && task.sessionId === sessionId).map(task => task.id));
  return records.filter(task => all || task.sessionId === sessionId || parents.has(task.supervisorId))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
}

export function taskSnapshot(root, task, records) {
  const children = records.filter(child => child.supervisorId === task.id);
  const activeChildren = children.filter(child => !TERMINAL_TASKS.has(child.status));
  const events = readTaskEvents(root, task.id);
  const terminal = TERMINAL_TASKS.has(task.status);
  return {
    taskId: task.id,
    status: task.status,
    workState: activeChildren.length ? 'waiting_for_children' : terminal ? 'result_available' : 'working',
    ready: terminal && activeChildren.length === 0,
    attentionRequired: task.status === 'failed' || (!terminal && events.some(event => ['task.input_required', 'permission.denied'].includes(event.type))),
    eventCursor: events.at(-1)?.sequence ?? 0,
    terminalEventSequence: events.findLast(event => event.type === `task.${task.status}`)?.sequence ?? null,
    childTaskIds: children.map(child => child.id),
    activeChildTaskIds: activeChildren.map(child => child.id),
    task,
  };
}

export function selectTask(root, records, id) {
  return taskSnapshot(root, resolveResultJob(records, id), records);
}

export async function waitForTask(root, sessionId, id, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const records = visibleTasks(root, sessionId);
    const snapshot = selectTask(root, records, id);
    if (snapshot.ready || Date.now() >= deadline) return { ...snapshot, waitTimedOut: !snapshot.ready };
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
}

function workerExited(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code !== 'EPERM'; }
}

// Unbounded on purpose: a host runs this as a background command whose exit re-invokes the parent,
// so it must return only when the parent has something to act on, never on a polling budget.
export async function waitForWake(root, sessionId, id) {
  while (true) {
    const snapshot = selectTask(root, visibleTasks(root, sessionId), id);
    if (snapshot.ready || snapshot.attentionRequired) return { ...snapshot, waitTimedOut: false };
    if (workerExited(snapshot.task.workerPid)) {
      // Re-read so a worker that recorded its result just before exiting is not reported as lost.
      const latest = selectTask(root, visibleTasks(root, sessionId), id);
      return { ...latest, waitTimedOut: false, workerExited: !latest.ready };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const line = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const short = (value, size = 72) => { const text = line(value); return text.length > size ? text.slice(0, size - 3) + '...' : text; };

export function renderTaskList(root, records) {
  if (!records.length) return 'No tasks in this session.';
  const sorted = [...records.filter(task => !task.supervisorId), ...records.filter(task => task.supervisorId && !records.some(parent => parent.id === task.supervisorId))];
  const output = ['TASK / ROLE / PROVIDER                 STATE'];
  const render = (task, indent = '') => {
    const snapshot = taskSnapshot(root, task, records);
    const provider = task.kind === 'run' ? 'supervisor' : `${task.executor}/${task.integration ?? 'cli'}`;
    output.push(`${indent}${task.id}  ${task.role ?? task.kind}  ${provider}  ${snapshot.workState} (${task.status}, ${line(task.phase)})${snapshot.attentionRequired ? ' [attention]' : ''}`);
    output.push(`${indent}  ${short(task.title ?? task.request)}${task.context ? `  [context r${task.context.revision}]` : ''}`);
    for (const child of records.filter(child => child.supervisorId === task.id)) render(child, indent + '  ');
  };
  for (const task of sorted) render(task);
  return output.join('\n');
}

export function renderTaskSnapshot(snapshot) {
  const { task } = snapshot;
  const provider = task.kind === 'run' ? 'supervisor' : `${task.executor}/${task.integration ?? 'cli'}`;
  const lines = [`${task.id}: ${snapshot.workState} (${task.status})`, `Role: ${task.role ?? task.kind} | Provider: ${provider}`, `Phase: ${line(task.phase)} | Events: ${snapshot.eventCursor}`, `Workspace: ${line(task.workspaceRoot)}`];
  if (task.conversationId) lines.push(`Native session: ${line(task.conversationId)}`);
  if (task.context) lines.push(`Context: ${task.context.id}, revision ${task.context.revision}`);
  if (snapshot.childTaskIds.length) lines.push(`Children: ${snapshot.childTaskIds.join(', ')}`);
  if (task.result?.response || task.summary) lines.push('', line(task.result?.response ?? task.summary));
  if (task.errorMessage) lines.push('', `Error: ${line(task.errorMessage)}`);
  if (task.evidence) lines.push(`Acceptance: ${task.evidence.accepted ? 'passed' : 'rejected'}${task.integrated ? '; integrated' : ''}`);
  if (task.logFile) lines.push(`Log: ${line(task.logFile)}`);
  if (snapshot.waitTimedOut) lines.push('Wait timed out; the task remains active.');
  return lines.join('\n');
}
