import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const scenario = JSON.parse(process.env.RPC_FIXTURE_SCENARIO ?? '{}');
const acp = !process.argv.includes('app-server');
const capture = process.env.RPC_FIXTURE_CAPTURE;
const emit = value => { const text = JSON.stringify(value) + '\n'; process.stdout.write(text.slice(0, 7)); process.stdout.write(text.slice(7)); };
const reply = (id, result) => emit({ jsonrpc: '2.0', id, result });
const notify = (method, params) => emit({ jsonrpc: '2.0', method, params });
let pendingPrompt, pendingApproval, finalText = 'PONG', sessionId = 'native-session';
function complete(text = finalText, status = 'completed') {
  if (acp) {
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    reply(pendingPrompt, { stopReason: status === 'completed' ? 'end_turn' : 'cancelled' });
  } else {
    notify('item/completed', { threadId: sessionId, item: { type: 'agentMessage', text: 'commentary before final' } });
    notify('item/completed', { threadId: 'foreign-thread', item: { type: 'agentMessage', text: 'WRONG' } });
    notify('item/completed', { threadId: sessionId, item: { type: 'agentMessage', text } });
    notify('turn/completed', { threadId: sessionId, turn: { id: 'turn-1', status } });
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (capture) appendFileSync(capture, JSON.stringify(value) + '\n');
  const { id, method, params = {} } = value;
  if (id === 'permission') { pendingApproval = value.result; complete(JSON.stringify(pendingApproval)); continue; }
  if (!method) continue;
  if (method === 'initialize') {
    if (scenario.malformed) { process.stdout.write('not json\n'); continue; }
    if (scenario.initializeError) { emit({ id, error: { code: -1, message: 'fixture initialization failed' } }); continue; }
    reply(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
  } else if (method === 'account/read') {
    reply(id, { account: scenario.noAccount ? null : { type: 'chatgpt', email: 'private@example.com' }, requiresOpenaiAuth: true });
  } else if (method === 'model/list') {
    reply(id, { data: [{ model: params.cursor ? 'second-model' : 'fixture-model', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
      nextCursor: scenario.repeatedCursor || (scenario.modelPages && !params.cursor) ? 'page-2' : null });
  } else if (method === 'thread/start' || method === 'thread/resume') {
    sessionId = params.threadId ?? sessionId; reply(id, { thread: { id: sessionId } });
  } else if (method === 'session/new' || method === 'session/resume') {
    sessionId = params.sessionId ?? sessionId;
    reply(id, { sessionId, modes: { availableModes: scenario.noModes ? [] : [{ id: 'plan' }, { id: 'yolo' }] }, configOptions: [{ id: 'model', options: [{ value: 'fixture-model' }] }] });
  } else if (method === 'session/set_mode' || method === 'session/set_config_option') reply(id, {});
  else if (method === 'turn/start' || method === 'session/prompt') {
    pendingPrompt = id;
    finalText = params.outputSchema ? '{"answer":"PONG"}' : 'PONG';
    if (!acp) { reply(id, { turn: { id: 'turn-1' } }); notify('turn/started', { threadId: sessionId, turn: { id: 'turn-1' } }); }
    if (scenario.permission) emit({ jsonrpc: '2.0', id: 'permission', method: acp ? 'session/request_permission' : 'item/commandExecution/requestApproval', params: acp
      ? { sessionId: scenario.foreign ? 'foreign' : sessionId, toolCall: { toolCallId: 'write-1' }, options: [{ kind: 'allow_once', optionId: 'real-allow-id' }, { kind: 'reject_once', optionId: 'real-reject-id' }] }
      : { threadId: scenario.foreign ? 'foreign' : sessionId } });
    else if (!scenario.hang) setTimeout(() => complete(), 15);
  } else if (method === 'turn/steer') { reply(id, {}); complete(params.input[0].text); }
  else if (method === 'turn/interrupt') { reply(id, {}); complete('', 'interrupted'); }
  else if (method === 'session/cancel') complete('', 'cancelled');
}
