import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { runCommand } from '../process.mjs';
import { watchTaskControls } from '../task-controls.mjs';
import { outputSchema } from './codex-app-server.mjs';

function inputQueue(prompt) {
  const messages = [prompt];
  let wake, closed = false;
  return {
    submitted: 1,
    push(message) { if (closed) throw new Error('Session input is closed'); this.submitted++; messages.push(message); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!messages.length) { await new Promise(resolve => { wake = resolve; }); wake = null; continue; }
        yield { type: 'user', message: { role: 'user', content: messages.shift() }, parent_tool_use_id: null, session_id: '' };
      }
    },
  };
}

function claudeBinary(options, env) {
  const binary = options.binary ?? env.CLAUDE_BINARY ?? 'claude';
  if (isAbsolute(binary)) return binary;
  const resolved = runCommand(process.platform === 'win32' ? 'where.exe' : 'which', [binary], { env, timeoutMs: 10000 });
  if (resolved.code !== 0) throw new Error(`Cannot locate Claude Code binary: ${binary}`);
  return resolved.stdout.trim().split(/\r?\n/)[0];
}

export async function runClaudeAgentSdk({ job = {}, prompt, options = {}, onProgress = () => {}, onTaskEvent = () => {}, onStderrLine }, { cwd = process.cwd(), env = process.env, queryFactory } = {}) {
  const { query } = queryFactory ? { query: queryFactory } : await import('@anthropic-ai/claude-agent-sdk').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return import('../../vendor/claude-agent-sdk.mjs');
  });
  const input = inputQueue(prompt);
  const abortController = new AbortController();
  const result = { status: 'failed', response: '', error: null, conversationId: null, structuredOutput: null, usage: null, changedFiles: [] };
  const writable = job.jobClass !== 'review' && !options.readOnly && options.approveAll === true;
  let timedOut = false, interrupted = false, terminal = false, completedTurns = 0;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); input.close(); }, options.timeoutMs ?? 30 * 60 * 1000);
  const signal = () => abortController.abort();
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  let session, stopControls = () => {};
  try {
    session = query({ prompt: input, options: {
      cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, pathToClaudeCodeExecutable: queryFactory ? options.binary : claudeBinary(options, env),
      abortController, settingSources: ['user', 'project', 'local'],
      permissionMode: writable ? 'default' : 'plan',
      tools: writable ? ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'TodoWrite', 'AskUserQuestion'] : ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
      disallowedTools: ['Agent', 'Skill'],
      ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}),
      ...(options.conversation ? { resume: options.conversation } : {}),
      ...(options.jsonSchema ? { outputFormat: { type: 'json_schema', schema: outputSchema(options.jsonSchema, cwd) } } : {}),
      stderr: onStderrLine,
      spawnClaudeCodeProcess(input) {
        const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, signal: input.signal, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
        child.once('spawn', () => onProgress({ type: 'spawn', pid: child.pid, binary: input.command }));
        return child;
      },
      canUseTool: async (name, toolInput) => {
        if (name === 'AskUserQuestion') {
          onTaskEvent({ type: 'task.input_required', data: { questions: toolInput.questions } });
          return { behavior: 'deny', message: 'Report this question as a blocker to the parent. Do not invent an answer.' };
        }
        if (writable && ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'TodoWrite'].includes(name)) return { behavior: 'allow', updatedInput: toolInput };
        onTaskEvent({ type: 'permission.denied', data: { tool: name } });
        return { behavior: 'deny', message: 'This task does not authorize additional tool permissions.' };
      },
    } });
    stopControls = watchTaskControls(options.stateRoot, job.id, {
      steer: async message => { input.push(message); },
      interrupt: async () => { interrupted = true; await session.interrupt(); },
    }, onTaskEvent);
    for await (const event of session) {
      if (event.session_id && !result.conversationId) {
        result.conversationId = event.session_id;
        onTaskEvent({ type: 'session.started', data: { conversationId: event.session_id, integration: 'agent-sdk' } });
      }
      if (event.type === 'assistant') for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') {
          onProgress({ type: 'tool', name: block.name });
          if (['Write', 'Edit'].includes(block.name) && block.input?.file_path) result.changedFiles.push(block.input.file_path);
        }
      }
      if (event.type === 'system' && event.subtype === 'permission_denied') onTaskEvent({ type: 'permission.denied', data: { tool: event.tool_name ?? 'unknown' } });
      if (event.type === 'result') {
        terminal = true;
        result.status = interrupted ? 'cancelled' : !event.is_error && event.subtype === 'success' ? 'completed' : 'failed';
        result.response = event.result ?? '';
        result.error = result.status === 'failed' ? (event.errors?.join('\n') || event.result || event.subtype) : null;
        result.structuredOutput = event.structured_output ?? null;
        result.usage = event.usage ?? null;
        for (const denial of event.permission_denials ?? []) onTaskEvent({ type: 'permission.denied', data: { tool: denial.tool_name ?? 'unknown' } });
        completedTurns++;
        if (interrupted || result.status !== 'completed' || completedTurns >= input.submitted) break;
      }
    }
    if (!terminal) throw new Error('Claude Agent SDK exited without a terminal result');
    if (options.jsonSchema && result.status === 'completed' && result.structuredOutput === null) throw new Error('Claude Agent SDK returned no structured output');
  } catch (error) { result.status = interrupted ? 'cancelled' : 'failed'; result.error = timedOut ? `Executor timed out after ${options.timeoutMs}ms` : error.message; }
  finally { stopControls(); input.close(); session?.close(); clearTimeout(timer); process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal); }
  return { ...result, changedFiles: [...new Set(result.changedFiles)], exitCode: result.status === 'completed' ? 0 : 1 };
}
