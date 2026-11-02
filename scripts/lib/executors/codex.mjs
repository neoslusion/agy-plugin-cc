import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectContext } from './agy.mjs';
import { cliPreflight, runCli, terminateProcess } from './cli-process.mjs';

export function buildCodexArgs({ job = {}, options = {} }) {
  if (options.agent) throw new Error('codex executor does not support --agent; select a model or use native host subagents');
  const args = [];
  const approve = job.jobClass !== 'review' && !options.readOnly && options.approveAll;
  // The bypass flag already disables approvals; Codex 0.163 rejects it together with -a.
  if (approve) args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('-a', 'never', '--sandbox', 'read-only');
  if (options.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  if (options.advisorServer) {
    const { name, command, args: serverArgs } = options.advisorServer;
    // Codex requires approval for MCP tools and never prompts here; consultations can take minutes.
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(command)}`, '-c', `mcp_servers.${name}.args=${JSON.stringify(serverArgs)}`,
      '-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`, '-c', `mcp_servers.${name}.tool_timeout_sec=900`);
  }
  args.push('exec');
  if (options.conversation) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (options.model) args.push('--model', options.model);
  if (options.jsonSchema) args.push('--output-schema', options.jsonSchema);
  if (options.conversation) args.push(options.conversation);
  args.push('-');
  return args;
}

export async function runTask({ job = {}, prompt, options = {}, onProgress = () => {}, ...handlers }, { cwd, env = process.env } = {}) {
  let schemaDir;
  let schemaPath;
  try {
    let opts = { ...options };
    if (options.jsonSchema) {
      const value = String(options.jsonSchema);
      if (value.trim().startsWith('{')) {
        JSON.parse(value);
        schemaDir = mkdtempSync(join(tmpdir(), 'delegation-schema-'));
        schemaPath = join(schemaDir, 'schema.json');
        writeFileSync(schemaPath, value);
      } else {
        schemaPath = resolve(cwd ?? process.cwd(), value);
        JSON.parse(readFileSync(schemaPath, 'utf8'));
      }
      opts.jsonSchema = schemaPath;
    }
    const result = { status: 'failed', response: '', error: null, conversationId: null, usage: null, structuredOutput: null, changedFiles: [] };
    let terminal = false;
    const output = await runCli({
      binary: options.binary ?? env.CODEX_BINARY ?? 'codex', args: buildCodexArgs({ job, options: opts }),
      prompt, cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, timeoutMs: options.timeoutMs, onProgress, ...handlers,
      onEvent(event) {
        if (event.type === 'thread.started') result.conversationId = event.thread_id;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') result.response = event.item.text ?? '';
        if (event.type === 'item.started') onProgress({ type: 'tool', name: event.item?.type ?? 'working' });
        if (event.type === 'item.completed' && event.item?.type === 'file_change') {
          for (const change of event.item.changes ?? []) if (change.path) result.changedFiles.push(change.path);
        }
        if (event.type === 'turn.completed') { terminal = true; result.status = 'completed'; result.usage = event.usage ?? null; }
        if (event.type === 'turn.failed') { terminal = true; result.status = 'failed'; result.error = event.error?.message ?? 'Codex turn failed'; }
      },
    });
    if (output.error || output.exitCode !== 0 || !terminal) {
      result.status = 'failed';
      result.error = output.error ?? result.error ?? (output.stderr.trim() || 'Codex exited without a completed turn');
    }
    if (options.jsonSchema && result.status === 'completed') {
      try { result.structuredOutput = JSON.parse(result.response); }
      catch { result.status = 'failed'; result.error = 'Codex returned invalid structured output'; }
    }
    return { ...result, exitCode: output.exitCode, notice: output.stderr.trim() || null };
  } finally {
    if (schemaDir) { unlinkSync(schemaPath); rmdirSync(schemaDir); }
  }
}

export const codexExecutor = { id: 'codex', binary: 'codex', preflight: opts => cliPreflight('codex', opts), runTask, collectContext, cancel: terminateProcess };
