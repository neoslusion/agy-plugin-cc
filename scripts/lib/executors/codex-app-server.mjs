import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RpcProcess, deferred } from './rpc-process.mjs';
import { watchTaskControls } from '../task-controls.mjs';

export function outputSchema(value, cwd) {
  if (!value) return undefined;
  return typeof value === 'object' ? value : JSON.parse(String(value).trim().startsWith('{') ? value : readFileSync(resolve(cwd, value), 'utf8'));
}

export async function runCodexAppServer({ job = {}, prompt, options = {}, onProgress = () => {}, onTaskEvent = () => {}, onStderrLine }, { cwd = process.cwd(), env = process.env } = {}) {
  const terminal = deferred();
  const result = { status: 'failed', response: '', error: null, conversationId: null, usage: null, structuredOutput: null, changedFiles: [] };
  let turnId, stopControls = () => {};
  const writable = job.jobClass !== 'review' && !options.readOnly && options.approveAll === true;
  const rpc = new RpcProcess({ binary: options.binary ?? env.CODEX_BINARY ?? 'codex', args: ['app-server'], cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, timeoutMs: options.timeoutMs, onProgress, onStderrLine, onFailure: terminal.reject,
    onNotification(method, params) {
      if (params?.threadId && result.conversationId && params.threadId !== result.conversationId) return;
      if (method === 'turn/started') turnId = params.turn.id;
      if (method === 'item/started') onProgress({ type: 'tool', name: params.item?.type ?? 'working' });
      if (method === 'item/completed') {
        if (params.item?.type === 'agentMessage') result.response = params.item.text ?? '';
        if (params.item?.type === 'fileChange') for (const change of params.item.changes ?? []) if (change.path) result.changedFiles.push(change.path);
      }
      if (method === 'thread/tokenUsage/updated') result.usage = params.tokenUsage;
      if (method === 'turn/completed') {
        result.status = params.turn.status === 'completed' ? 'completed' : params.turn.status === 'interrupted' ? 'cancelled' : 'failed';
        result.error = params.turn.error?.message ?? null;
        terminal.resolve();
      }
    },
    onRequest(method, params, id) {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const allowed = writable && (!params.threadId || params.threadId === result.conversationId);
        onTaskEvent({ type: allowed ? 'permission.granted' : 'permission.denied', data: { requestId: String(id), method } });
        return { decision: allowed ? 'accept' : 'decline' };
      }
      if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
      if (method === 'item/tool/requestUserInput') {
        onTaskEvent({ type: 'task.input_required', data: { requestId: String(id), questions: params.questions } });
        return { answers: {} };
      }
      return undefined;
    },
  });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'agent_delegation', title: 'Agent Delegation', version: '0.2.0' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const args = { cwd, approvalPolicy: 'never', sandbox: writable ? 'danger-full-access' : 'read-only', ...(options.model ? { model: options.model } : {}) };
    const thread = await rpc.request(options.conversation ? 'thread/resume' : 'thread/start', { ...args, ...(options.conversation ? { threadId: options.conversation } : {}) });
    result.conversationId = thread.thread.id;
    onTaskEvent({ type: 'session.started', data: { conversationId: result.conversationId, integration: 'app-server' } });
    const started = await rpc.request('turn/start', { threadId: result.conversationId, input: [{ type: 'text', text: prompt }], ...(options.effort ? { effort: options.effort } : {}), ...(options.jsonSchema ? { outputSchema: outputSchema(options.jsonSchema, cwd) } : {}) });
    turnId = started.turn.id;
    stopControls = watchTaskControls(options.stateRoot, job.id, {
      steer: message => rpc.request('turn/steer', { threadId: result.conversationId, expectedTurnId: turnId, input: [{ type: 'text', text: message }] }),
      interrupt: () => rpc.request('turn/interrupt', { threadId: result.conversationId, turnId }),
    }, onTaskEvent);
    await terminal.promise;
    if (result.status === 'completed' && options.jsonSchema) result.structuredOutput = JSON.parse(result.response);
  } catch (error) { result.status = 'failed'; result.error = error.message; }
  finally { stopControls(); rpc.close(); }
  return { ...result, changedFiles: [...new Set(result.changedFiles)], exitCode: result.status === 'completed' ? 0 : 1 };
}
