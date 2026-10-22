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
  if (options.conversation) args.push('--resume', options.conversation);
  if (options.jsonSchema) {
    const value = String(options.jsonSchema);
    const schema = JSON.parse(value.trim().startsWith('{') ? value : readFileSync(resolve(cwd, value), 'utf8'));
    args.push('--json-schema', JSON.stringify(schema));
  }
  return args;
}

export async function runTask({ job = {}, prompt, options = {}, onProgress = () => {}, ...handlers }, { cwd, env = process.env } = {}) {
  const result = { status: 'failed', response: '', error: null, conversationId: null, usage: null, structuredOutput: null, changedFiles: [] };
  let terminal = false;
  const output = await runCli({
    binary: options.binary ?? env.CLAUDE_BINARY ?? 'claude', args: buildClaudeArgs({ job, options, cwd }),
    prompt, cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, timeoutMs: options.timeoutMs, onProgress, ...handlers,
    onEvent(event) {
      if (event.session_id) result.conversationId = event.session_id;
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') onProgress({ type: 'tool', name: block.name });
        }
      }
      if (event.type === 'result') {
        terminal = true;
        result.status = !event.is_error && event.subtype === 'success' ? 'completed' : 'failed';
        result.response = event.result ?? '';
        result.error = result.status === 'failed' ? (event.errors?.join('\n') || event.result || event.subtype || 'Claude turn failed') : null;
        result.usage = event.usage ?? null;
        result.structuredOutput = event.structured_output ?? null;
      }
    },
  });
  if (output.error || output.exitCode !== 0 || !terminal) {
    result.status = 'failed';
    result.error = output.error ?? result.error ?? (output.stderr.trim() || 'Claude exited without a result');
  }
  if (options.jsonSchema && result.status === 'completed' && result.structuredOutput === null) {
    result.status = 'failed'; result.error = 'Claude returned no structured output';
  }
  return { ...result, exitCode: output.exitCode, notice: output.stderr.trim() || null };
}

export const claudeExecutor = { id: 'claude', binary: 'claude', preflight: opts => cliPreflight('claude', opts), runTask, collectContext, cancel: terminateProcess };
