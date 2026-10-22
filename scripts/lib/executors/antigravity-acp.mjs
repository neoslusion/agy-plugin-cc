import { RpcProcess } from './rpc-process.mjs';
import { watchTaskControls } from '../task-controls.mjs';

export async function runAntigravityAcp({ job = {}, prompt, options = {}, onProgress = () => {}, onTaskEvent = () => {}, onStderrLine }, { cwd = process.cwd(), env = process.env } = {}) {
  if (options.jsonSchema) throw new Error('Antigravity ACP has no schema-constrained output; use cli integration for supervisor roles');
  if (options.effort) throw new Error('Antigravity ACP effort selection is not supported by this adapter');
  const binary = options.binary ?? env.AGY_ACP_BINARY;
  if (!binary) throw new Error('ACP integration requires AGY_ACP_BINARY pointing to the separately installed Google Antigravity ACP server');
  const result = { status: 'failed', response: '', error: null, conversationId: null, structuredOutput: null, usage: null, changedFiles: [] };
  const writable = job.jobClass !== 'review' && !options.readOnly && options.approveAll === true;
  const writes = new Set();
  let interrupted = false, stopControls = () => {};
  const rpc = new RpcProcess({ binary, args: process.platform === 'linux' ? ['--uid='] : [], cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, timeoutMs: options.timeoutMs, onProgress, onStderrLine,
    onNotification(method, params) {
      if (method !== 'session/update' || params.sessionId !== result.conversationId) return;
      const update = params.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') result.response += update.content.text;
      if (update?.sessionUpdate === 'tool_call') {
        onProgress({ type: 'tool', name: update.title ?? update.kind ?? 'working' });
        if (['edit', 'delete', 'move'].includes(update.kind)) {
          writes.add(update.toolCallId);
          for (const location of update.locations ?? []) if (location.path) result.changedFiles.push(location.path);
        }
      }
      if (update?.sessionUpdate === 'tool_call_update') {
        if (writes.has(update.toolCallId)) for (const location of update.locations ?? []) if (location.path) result.changedFiles.push(location.path);
        if (update.status === 'failed') onTaskEvent({ type: 'tool.failed', data: { toolCallId: update.toolCallId } });
      }
    },
    onRequest(method, params, id) {
      if (method !== 'session/request_permission') return undefined;
      const allowed = writable && params.sessionId === result.conversationId;
      const kind = allowed ? 'allow_once' : 'reject_once';
      const option = params.options?.find(option => option.kind === kind);
      onTaskEvent({ type: allowed && option ? 'permission.granted' : 'permission.denied', data: { requestId: String(id), toolCallId: params.toolCall?.toolCallId } });
      return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
    },
  });
  try {
    const initialized = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-delegation', version: '0.2.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    // This endpoint owns its own credentials. Never copy tokens from the agy CLI.
    if (options.conversation && !initialized.agentCapabilities?.sessionCapabilities?.resume) throw new Error('This ACP server does not advertise session resume');
    const session = await rpc.request(options.conversation ? 'session/resume' : 'session/new', { cwd, mcpServers: [], ...(options.conversation ? { sessionId: options.conversation } : {}) });
    result.conversationId = options.conversation ?? session.sessionId;
    const configOptions = session.configOptions ?? [];
    if (options.model) {
      const config = configOptions.find(option => option.id === 'model');
      const choices = config?.options?.flatMap(option => option.options ?? [option]) ?? [];
      if (!choices.some(option => option.value === options.model)) throw new Error(`ACP model is unavailable: ${options.model}`);
      await rpc.request('session/set_config_option', { sessionId: result.conversationId, configId: config.id, value: options.model });
    }
    const modes = session.modes?.availableModes ?? [];
    const mode = writable ? 'yolo' : 'plan';
    if (!modes.some(entry => entry.id === mode)) throw new Error(`ACP server does not advertise required ${mode} permission mode`);
    await rpc.request('session/set_mode', { sessionId: result.conversationId, modeId: mode });
    onTaskEvent({ type: 'session.started', data: { conversationId: result.conversationId, integration: 'acp' } });
    stopControls = watchTaskControls(options.stateRoot, job.id, {
      interrupt: async () => { interrupted = true; rpc.notify('session/cancel', { sessionId: result.conversationId }); },
    }, onTaskEvent);
    const finished = await rpc.request('session/prompt', { sessionId: result.conversationId, prompt: [{ type: 'text', text: prompt }] });
    result.status = interrupted || finished.stopReason === 'cancelled' ? 'cancelled' : finished.stopReason === 'end_turn' ? 'completed' : 'failed';
    if (result.status === 'failed') result.error = `ACP prompt stopped: ${finished.stopReason}`;
  } catch (error) { result.error = error.message; }
  finally { stopControls(); rpc.close(); }
  return { ...result, changedFiles: [...new Set(result.changedFiles)], exitCode: result.status === 'completed' ? 0 : 1 };
}
