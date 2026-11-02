// Advisor for delegated workers, modelled on Claude Code's advisor tool: a stronger model that reads
// the worker's transcript and returns guidance. Workers consult it through an MCP tool; the runner
// also has it review every finished turn, because weaker workers rarely notice when they need help.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRoute } from './delegation-config.mjs';
import { get } from './executors/registry.mjs';
import { runCommand } from './process.mjs';
import { appendTaskEvent, readTaskEvents } from './task-events.mjs';

export const MAX_CONSULTATIONS = 4;
const TRANSCRIPT_CHARS = 60_000, DIFF_CHARS = 40_000, FIELD_CHARS = 2_000;
const MCP_SERVER = join(import.meta.dirname, '..', 'mcp-server.mjs');
export const ADVISOR_SERVER_NAME = 'delegation_advisor';
export const ADVISOR_TOOL = 'consult_advisor';

export const WORKER_GUIDANCE = `An advisor, a stronger model that can see your work so far, is available through the ${ADVISOR_TOOL} tool. Consult it before committing to an approach on non-trivial work, when an error recurs or you are stuck, and before declaring the task complete when you are unsure. Apply its guidance unless your own evidence contradicts it; then say so in your handoff. The advisor reviews your finished work and may send corrections. If you need a decision outside your assignment, end your turn with a line starting "BLOCKED:" followed by the question.`;

const ADVISOR_ROLE = 'You are the advisor for a delegated coding worker. You do not edit files or run commands that change state; you may read files to check claims. Judge the work against the assignment and the evidence, not against the worker\'s own claims.';

const clip = (value, max = FIELD_CHARS) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more chars]` : text;
};

// Renders the worker's recorded event stream as a readable transcript. Each executor emits its own
// event shapes; unknown events are skipped, so the transcript is best-effort evidence.
function renderEvent(event) {
  if (event.type === 'assistant' || event.type === 'user') {
    return (event.message?.content ?? []).map(block => {
      if (block.type === 'text' && block.text) return `${event.type === 'assistant' ? 'Worker' : 'User'}: ${block.text}`;
      if (block.type === 'tool_use') return `Tool call ${block.name}: ${clip(block.input)}`;
      if (block.type === 'tool_result') return `Tool result${block.is_error ? ' (error)' : ''}: ${clip(Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join('\n') : block.content)}`;
      return null;
    }).filter(Boolean);
  }
  if (event.type === 'item.completed' && event.item) {
    const item = event.item;
    if (item.type === 'agent_message') return [`Worker: ${item.text}`];
    if (item.type === 'command_execution') return [`Command ${clip(item.command, 500)} (exit ${item.exit_code ?? '?'}): ${clip(item.aggregated_output)}`];
    if (item.type === 'file_change') return [`File changes: ${clip(item.changes)}`];
    if (item.type === 'mcp_tool_call') return [`Tool call ${item.server}.${item.tool}: ${clip(item.arguments)} → ${clip(item.result ?? item.error)}`];
    return [];
  }
  if (event.type === 'text' && event.part?.text) return [`Worker: ${event.part.text}`];
  if (event.type === 'tool_use' && event.part?.state?.status === 'completed') return [`Tool call ${event.part.tool}: ${clip(event.part.state.input)} → ${clip(event.part.state.output)}`];
  if (event.type === 'error' && event.error) return [`Error: ${clip(event.error)}`];
  return [];
}

export function workerTranscript(logFile, maxChars = TRANSCRIPT_CHARS) {
  if (!logFile || !existsSync(logFile)) return '(no transcript recorded)';
  const lines = [];
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    const match = /^\[[^\]]+\] out: (\{.*\})\s*$/.exec(line);
    if (!match) continue;
    try { lines.push(...renderEvent(JSON.parse(match[1]))); } catch {}
  }
  const text = lines.join('\n');
  // Keep the most recent work when the transcript is long; the assignment is supplied separately.
  return text.length > maxChars ? `[earlier transcript omitted]\n${text.slice(-maxChars)}` : text || '(no transcript recorded)';
}

function workspaceDiff(cwd) {
  const inside = runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside.code !== 0) return '(not a git repository)';
  const diff = runCommand('git', ['diff', 'HEAD'], { cwd }).stdout ?? '';
  const untracked = (runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd }).stdout ?? '').trim();
  return [clip(diff || '(no tracked changes)', DIFF_CHARS), untracked ? `Untracked files:\n${clip(untracked)}` : ''].filter(Boolean).join('\n\n');
}

async function runAdvisor({ route, prompt, cwd, env }) {
  const adapter = get(route.executor, route.integration ?? 'cli');
  const result = await adapter.runTask({ job: { jobClass: 'review' }, prompt, options: {
    model: route.model, effort: route.effort, readOnly: true, approveAll: false, outputFormat: 'stream-json',
    timeoutMs: route['timeout-ms'] ? Number(route['timeout-ms']) : 600_000,
  } }, { cwd, env });
  if (result.status !== 'completed' || !result.response?.trim()) throw new Error(result.error || 'advisor returned no guidance');
  return result.response.trim();
}

// A worker's mid-turn question. Failures return a message rather than throwing, so the worker continues.
export async function consultAdvisor({ root, job, route, question, env = process.env }) {
  const used = readTaskEvents(root, job.id).filter(event => event.type === 'advisor.consulted').length;
  if (used >= MAX_CONSULTATIONS) return { ok: false, text: `Advisor budget of ${MAX_CONSULTATIONS} consultations is used up. Proceed on your best judgment, or end with "BLOCKED:" and your question.` };
  const prompt = `${ADVISOR_ROLE}\n\nThe worker is asking for advice mid-task. Give concise, actionable guidance: what to do next and what to avoid. If the question needs a decision outside the assignment, say that the worker should report it as BLOCKED.\n\nAssignment:\n${job.assignment ?? job.request}\n\nWorker transcript so far:\n${workerTranscript(job.logFile)}\n\nWorker question:\n${question}`;
  try {
    const guidance = await runAdvisor({ route, prompt, cwd: job.workspaceRoot, env });
    appendTaskEvent(root, job.id, 'advisor.consulted', { question: clip(question), guidance: clip(guidance, 8192), ok: true });
    return { ok: true, text: guidance };
  } catch (error) {
    appendTaskEvent(root, job.id, 'advisor.consulted', { question: clip(question), error: clip(error.message), ok: false });
    return { ok: false, text: `Advisor unavailable (${clip(error.message, 300)}). Proceed on your best judgment.` };
  }
}

export function parseVerdict(text) {
  const match = /^\s*\**(APPROVE|REVISE|ESCALATE)\b\**[:.\s-]*/i.exec(text);
  return match ? { verdict: match[1].toUpperCase(), guidance: text.slice(match[0].length).trim() } : null;
}

// Reviews a finished worker turn: `done` for a completed turn, `blocked` for a BLOCKED report and
// `stuck` for a failed turn. Returns APPROVE, REVISE (guidance for the worker) or ESCALATE.
export async function reviewTurn({ root, job, route, result, kind, round, rounds, env = process.env }) {
  const situation = {
    done: 'The worker reports that it finished. Check the work against the assignment using the diff and transcript.',
    blocked: 'The worker stopped with a BLOCKED question. Answer it if the assignment and evidence settle it; escalate it if only the orchestrator or user can decide.',
    stuck: 'The worker turn failed. Diagnose the failure from the transcript and say how to recover, or escalate if recovery needs the orchestrator.',
  }[kind];
  const prompt = `${ADVISOR_ROLE}\n\n${situation}\n\nReply with exactly one verdict word on the first line, then your guidance:\n- APPROVE: the assignment is met and the evidence supports it. Do not withhold approval for style preferences.\n- REVISE: concrete corrections the worker must make. Address the worker directly; it will resume its session with your guidance. This is review round ${round} of ${rounds}.\n- ESCALATE: a question only the orchestrator or user can answer (scope, permissions, conflicting requirements).\n\nAssignment:\n${job.assignment ?? job.request}\n\nWorker ${kind === 'stuck' ? `error:\n${clip(result.error)}` : `handoff:\n${clip(result.response, 8192)}`}\n\nWorkspace changes:\n${workspaceDiff(job.workspaceRoot)}\n\nWorker transcript:\n${workerTranscript(job.logFile)}`;
  const response = await runAdvisor({ route, prompt, cwd: job.workspaceRoot, env });
  const parsed = parseVerdict(response);
  if (!parsed) throw new Error(`advisor reply had no verdict: ${clip(response, 300)}`);
  appendTaskEvent(root, job.id, 'advisor.reviewed', { kind, round, verdict: parsed.verdict, guidance: clip(parsed.guidance, 8192) });
  return parsed;
}

export function turnKind(result) {
  if (result.status === 'failed') return 'stuck';
  return /^\s*BLOCKED:/m.test(result.response ?? '') ? 'blocked' : 'done';
}

// Reviews each finished worker turn and resumes the worker's session with REVISE guidance, at most
// `rounds` times. An unavailable advisor ends the reviews visibly instead of failing the task.
export async function adviseTurns({ root, job, route, rounds, result, resume, isCancelled = () => false, env = process.env }) {
  const advice = { reviews: 0, verdict: null };
  const changedFiles = new Set(result.changedFiles ?? []);
  for (let resumes = 0; result.status !== 'cancelled' && !isCancelled();) {
    let review;
    try { review = await reviewTurn({ root, job, route, result, kind: turnKind(result), round: resumes + 1, rounds: rounds + 1, env }); }
    catch (error) {
      appendTaskEvent(root, job.id, 'advisor.unavailable', { error: clip(error.message) });
      advice.unavailable = clip(error.message, 500);
      break;
    }
    advice.reviews += 1;
    advice.verdict = review.verdict;
    if (review.verdict === 'APPROVE') break;
    if (review.verdict === 'ESCALATE') { advice.escalation = review.guidance; break; }
    if (resumes >= rounds || !result.conversationId) { advice.unresolved = review.guidance; break; }
    resumes += 1;
    result = await resume(`The advisor reviewed your work and asks for corrections:\n\n${review.guidance}\n\nApply them, re-run the relevant checks, and give an updated handoff.`, result.conversationId);
    for (const file of result.changedFiles ?? []) changedFiles.add(file);
  }
  advice.consultations = readTaskEvents(root, job.id).filter(event => event.type === 'advisor.consulted').length;
  return { ...result, changedFiles: [...changedFiles], advisor: advice };
}

// Execution settings for a route whose role names an advisor. The consult tool is injected only into
// CLI workers; other integrations still get turn reviews.
export function advisorExecution(config, route) {
  if (!route.advisorRole) return {};
  const advisor = resolveRoute(config, { role: route.advisorRole });
  return {
    'advisor-route': Object.fromEntries(['role', 'executor', 'integration', 'model', 'effort', 'timeout-ms'].filter(key => advisor[key] !== undefined).map(key => [key, advisor[key]])),
    'advisor-rounds': route.advisorRounds ?? 2,
    ...(route.integration === 'cli' ? { instructions: [route.instructions, WORKER_GUIDANCE].filter(Boolean).join('\n\n') } : {}),
  };
}

// The per-task MCP server that gives a worker the consult tool. Identity travels in arguments
// because Codex passes MCP servers only a fixed set of environment variables.
export function advisorServer(root, jobId) {
  return { name: ADVISOR_SERVER_NAME, command: process.execPath, args: [MCP_SERVER, '--advisor-task', jobId, '--state-root', root] };
}
