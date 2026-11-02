import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectContext } from './agy.mjs';
import { cliPreflight, runCli, terminateProcess } from './cli-process.mjs';

export function buildClaudeArgs({ job = {}, options = {}, cwd = process.cwd() }) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--disable-slash-commands'];
  if (job.jobClass !== 'review' && !options.readOnly && options.approveAll) args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'plan', '--tools', 'Read,Glob,Grep');
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.agent) args.push('--agent', options.agent);
  if (options.advisor) args.push('--advisor', options.advisor);
  if (options.advisorServer) {
    const { name, command, args: serverArgs } = options.advisorServer;
    args.push('--mcp-config', JSON.stringify({ mcpServers: { [name]: { command, args: serverArgs } } }), '--allowedTools', `mcp__${name}__consult_advisor`);
  }
  if (options.conversation) args.push('--resume', options.conversation);
  if (options.jsonSchema) {
    const value = String(options.jsonSchema);
    const schema = JSON.parse(value.trim().startsWith('{') ? value : readFileSync(resolve(cwd, value), 'utf8'));
    args.push('--json-schema', JSON.stringify(schema));
  }
  return args;
}

export function createClaudeStream({ advisor = false } = {}) {
  const result = { status: 'failed', response: '', error: null, conversationId: null, usage: null, structuredOutput: null, changedFiles: [] };
  if (advisor) result.advisorCalls = 0;
  return { result, terminal: false, advisorOff: false };
}

// Interpret one `claude --print --output-format stream-json` event. The advisor is a
// server tool, so it arrives as a content block rather than a separate stream.
export function applyClaudeEvent(stream, event, { advisor = false, onProgress = () => {} } = {}) {
  const result = stream.result;
  if (event.session_id) result.conversationId = event.session_id;
  // Claude Code enables the advisor through a fetched feature flag; the variables that disable
  // flag fetching also disable analytics, so a requested advisor is silently dropped.
  if (event.type === 'system' && event.subtype === 'init' && advisor && event.analytics_disabled === true) stream.advisorOff = true;
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') onProgress({ type: 'tool', name: block.name });
      if (block.type === 'server_tool_use' && block.name === 'advisor') {
        if (advisor) result.advisorCalls += 1;
        onProgress({ type: 'tool', name: 'advisor' });
      }
    }
  }
  if (event.type === 'result') {
    stream.terminal = true;
    result.status = !event.is_error && event.subtype === 'success' ? 'completed' : 'failed';
    result.response = event.result ?? '';
    result.error = result.status === 'failed' ? (event.errors?.join('\n') || event.result || event.subtype || 'Claude turn failed') : null;
    result.usage = event.usage ?? null;
    result.structuredOutput = event.structured_output ?? null;
  }
  return stream;
}

export async function runTask({ job = {}, prompt, options = {}, onProgress = () => {}, ...handlers }, { cwd, env = process.env } = {}) {
  const stream = createClaudeStream({ advisor: Boolean(options.advisor) });
  const output = await runCli({
    binary: options.binary ?? env.CLAUDE_BINARY ?? 'claude', args: buildClaudeArgs({ job, options, cwd }),
    prompt, cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, timeoutMs: options.timeoutMs, onProgress, ...handlers,
    onEvent(event) {
      applyClaudeEvent(stream, event, { advisor: Boolean(options.advisor), onProgress });
    },
  });
  const result = stream.result;
  if (output.error || output.exitCode !== 0 || !stream.terminal) {
    result.status = 'failed';
    result.error = output.error ?? result.error ?? (output.stderr.trim() || 'Claude exited without a result');
  }
  if (options.jsonSchema && result.status === 'completed' && result.structuredOutput === null) {
    result.status = 'failed'; result.error = 'Claude returned no structured output';
  }
  const advisorNotice = stream.advisorOff ? `advisor ${options.advisor} is likely off: this Claude session disables feature-flag fetching (e.g. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or DISABLE_TELEMETRY)` : null;
  return { ...result, exitCode: output.exitCode, notice: [output.stderr.trim(), advisorNotice].filter(Boolean).join('\n') || null };
}

export const claudeExecutor = { id: 'claude', binary: 'claude', integrations: ['cli', 'agent-sdk'], preflight: opts => cliPreflight('claude', opts), runTask, collectContext, cancel: terminateProcess };
