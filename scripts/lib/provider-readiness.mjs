import { statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve, join } from 'node:path';
import { runCommand } from './process.mjs';
import { parseArgs } from './args.mjs';
import { loadDelegationConfig, resolveRoute } from './delegation-config.mjs';
import { executorCapabilities } from './executors/capabilities.mjs';
import { findAntigravityRuntime } from './antigravity-runtime.mjs';
import { RpcProcess } from './executors/rpc-process.mjs';

const file = path => { try { return statSync(path).isFile(); } catch { return false; } };
export function locateProviderBinary(name, { cwd = process.cwd(), env = process.env } = {}) {
  if (isAbsolute(name) || /[\\/]/.test(name)) { const path = resolve(cwd, name); return file(path) ? path : null; }
  const suffixes = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const path = join(directory.replace(/^"|"$/g, ''), name + suffix);
      if (file(path)) return path;
    }
  }
  return null;
}

export async function probeCodexCatalog(binary, { cwd, env, timeoutMs = 10000 } = {}) {
  const rpc = new RpcProcess({ binary, args: ['app-server'], cwd, env, timeoutMs });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'agent_delegation', title: 'Agent Delegation', version: '0.2.0' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const account = await rpc.request('account/read', { refreshToken: false });
    const models = [], cursors = new Set(); let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Provider returned an invalid model catalog');
      for (const model of result.data) if (typeof model.model === 'string') models.push({ id: model.model, name: model.displayName ?? model.model,
        efforts: (model.supportedReasoningEfforts ?? []).map(effort => effort.reasoningEffort).filter(value => typeof value === 'string') });
      if (!result.nextCursor) return { protocolVerified: true, authenticated: account.requiresOpenaiAuth ? Boolean(account.account) : null,
        authMode: account.account?.type ?? null, models, catalogSource: 'codex-app-server', modelAccessVerified: false };
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('Model catalog cursor repeated or invalid');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('Model catalog exceeds 32 pages');
  } finally { rpc.close(); }
}

export async function probeClaudeCatalog(binary, { cwd, env, timeoutMs = 10000, queryFactory } = {}) {
  const { query } = queryFactory ? { query: queryFactory } : await import('@anthropic-ai/claude-agent-sdk').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return import('../vendor/claude-agent-sdk.mjs');
  });
  const abortController = new AbortController();
  let wake;
  // SDK control requests initialize the process without submitting an inference turn.
  const prompt = { async *[Symbol.asyncIterator]() { await new Promise(resolveWait => { wake = resolveWait; }); } };
  const session = query({ prompt, options: { cwd, env: { ...env, AGENT_DELEGATION_WORKER: '1' }, pathToClaudeCodeExecutable: binary, abortController,
    settingSources: ['user', 'project', 'local'], tools: [], permissionMode: 'plan' } });
  let timer;
  try {
    return await Promise.race([
      Promise.all([session.supportedModels(), session.accountInfo()]).then(([models, account]) => ({ protocolVerified: true, authenticated: null,
        authMode: account.tokenSource ?? account.apiKeySource ?? null,
        models: models.map(model => ({ id: model.value, name: model.displayName ?? model.value, efforts: model.supportedEffortLevels ?? [] })),
        catalogSource: 'claude-agent-sdk', modelAccessVerified: false })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Provider probe timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); abortController.abort(); wake?.(); session.close(); }
}

export async function probeAcpProtocol(binary, { cwd, env, timeoutMs = 10000 } = {}) {
  const rpc = new RpcProcess({ binary, cwd, env, timeoutMs });
  try {
    const result = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'agent-delegation', version: '0.2.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (result.protocolVersion !== 1) throw new Error('ACP runtime did not negotiate protocol version 1');
    return { protocolVerified: true, authenticated: null, models: null, catalogSource: null, modelAccessVerified: false,
      hint: 'ACP initialization passed. Authentication, advertised session modes/models and a completed task remain unverified.' };
  } finally { rpc.close(); }
}

export async function providerReadiness(executor, integration, { cwd, env = process.env, probe = false, timeoutMs, probes = {} } = {}) {
  // The official Antigravity ACP server takes about 30 seconds to answer initialize on Windows, even when warm.
  timeoutMs ??= integration === 'acp' ? 60000 : 10000;
  const capabilities = executorCapabilities(executor, integration);
  const runtime = integration === 'acp' ? findAntigravityRuntime({ cwd, env }) : null;
  const binary = runtime?.binary ?? (integration === 'acp' ? null : locateProviderBinary(env[`${executor.toUpperCase()}_BINARY`] ?? executor, { cwd, env }));
  const report = { executor, integration, binary, available: runtime ? runtime.status === 'ready' : Boolean(binary),
    protocolVerified: false, authenticated: null, models: null, modelAccessVerified: false, capabilities,
    probeIntegration: executor === 'codex' ? 'app-server' : executor === 'claude' ? 'agent-sdk' : integration,
    ...(runtime ? { runtime } : {}),
    // Google's FAQ and a Google forum moderator (discuss.ai.google.dev/t/187241, 2026-10-08) say third-party agents
    // orchestrating agy under a consumer login is unsupported and can trigger account suspension.
    ...(executor === 'agy' ? { policy: 'Google does not support orchestrating agy from third-party coding agents under a consumer (Free/Pro/Ultra) login and may suspend the account. Use a Gemini API key or Enterprise login, or another executor.' } : {}) };
  if (!report.available) return { ...report, hint: integration === 'acp' ? 'Run acp-setup --check, then acp-setup --install if missing.' : `Install ${executor} or set ${executor.toUpperCase()}_BINARY.` };
  if (!probe) return { ...report, hint: 'Executable found; use providers --probe to check the supported interface. Model access is verified only by a completed task.' };
  try {
    const inspect = probes[executor] ?? (executor === 'codex' ? probeCodexCatalog : executor === 'claude' ? probeClaudeCatalog : integration === 'acp' ? probeAcpProtocol : null);
    if (inspect) Object.assign(report, await inspect(binary, { cwd, env, timeoutMs }));
    else {
      const result = runCommand(/\.(mjs|cjs|js)$/i.test(binary) ? process.execPath : binary, /\.(mjs|cjs|js)$/i.test(binary) ? [binary, '--version'] : ['--version'], { cwd, env, timeoutMs });
      if (result.code !== 0) throw new Error('CLI version probe failed; check the installed runtime.');
      report.version = result.stdout.trim().slice(0, 256);
      report.hint = 'CLI starts; authentication and model discovery require its supported interface.';
    }
  } catch (error) { report.error = error.message; }
  return report;
}

export async function runProviderReadiness(argv, context = {}) {
  const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
  try {
    const { opts, positionals } = parseArgs(argv, { extraBool: ['probe'], extraValue: ['host'] });
    for (const key of Object.keys(opts)) if (!['cwd', 'config', 'host', 'role', 'executor', 'integration', 'probe', 'timeout-ms', 'json'].includes(key)) throw new Error(`--${key} is not supported by providers`);
    if (positionals.length) throw new Error('providers takes no positional arguments');
    if (env.AGENT_DELEGATION_WORKER === '1' && opts.probe) throw new Error('A delegated worker cannot start provider probes');
    const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
    const config = loadDelegationConfig(cwd, opts.config);
    const timeoutMs = opts['timeout-ms'] === undefined ? undefined : Number(opts['timeout-ms']);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)) throw new Error('Probe timeout must be an integer from 1 to 60000ms');
    const routes = opts.role || opts.executor ? [{ name: opts.role ?? opts.executor, ...resolveRoute(config, opts) }]
      : Object.keys(config.roles).length ? Object.keys(config.roles).map(name => ({ name, ...resolveRoute(config, { role: name, host: opts.host }) }))
        : ['codex', 'claude', 'opencode', 'agy'].map(executor => ({ name: executor, ...resolveRoute(config, { executor }) }));
    const reports = new Map();
    for (const route of routes) {
      const key = `${route.executor}/${route.integration}`;
      if (!reports.has(key)) reports.set(key, await providerReadiness(route.executor, route.integration, { cwd, env, probe: opts.probe === true, timeoutMs, probes: context.providerProbes }));
    }
    const roles = routes.map(route => {
      const report = reports.get(`${route.executor}/${route.integration}`);
      const model = report.models?.find(item => item.id === route.model);
      return { name: route.name, executor: route.executor, integration: route.integration, transport: route.transport, model: route.model ?? null,
        modelListed: route.model && report.models ? Boolean(model) : null,
        effortListed: route.effort && model?.efforts?.length ? model.efforts.includes(route.effort) : null };
    });
    const result = { providers: [...reports.values()], roles };
    out.write(opts.json ? JSON.stringify(result) + '\n' : [
      ...result.providers.map(report => `${report.executor}/${report.integration}: ${report.available ? 'executable found' : 'missing'}; ${report.probeIntegration} initialization ${report.protocolVerified ? 'verified' : 'unverified'}; auth ${report.authenticated === null ? 'unknown' : report.authenticated ? 'configured' : 'missing'}${report.error ? `; ${report.error}` : ''}${report.hint ? `\n  ${report.hint}` : ''}`),
      ...roles.map(role => `${role.name}: ${role.model ?? 'provider default'}${role.modelListed === false ? ' [not in catalog]' : ''}${role.effortListed === false ? ' [effort not in catalog]' : ''}`),
      'Catalog presence does not guarantee account access. No model substitutions or configuration changes were made.',
    ].join('\n') + '\n');
    return result.providers.some(report => !report.available || report.error || report.authenticated === false) || roles.some(role => role.modelListed === false || role.effortListed === false) ? 1 : 0;
  } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
}
