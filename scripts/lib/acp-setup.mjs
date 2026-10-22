import { resolve } from 'node:path';
import { parseArgs } from './args.mjs';
import { findAntigravityRuntime, installAntigravityRuntime, runtimeDirectory } from './antigravity-runtime.mjs';

export async function runAcpSetup(argv, context = {}) {
  const out = context.out ?? process.stdout, err = context.err ?? process.stderr, env = context.env ?? process.env;
  try {
    const { opts, positionals } = parseArgs(argv, { extraBool: ['install', 'check'], extraValue: ['directory'] });
    for (const key of Object.keys(opts)) if (!['cwd', 'directory', 'install', 'check', 'json'].includes(key)) throw new Error(`--${key} is not supported by acp-setup`);
    if (positionals.length || (opts.install && opts.check)) throw new Error('Use acp-setup [--check | --install] [--directory DIR] [--json]');
    if (env.AGENT_DELEGATION_WORKER === '1' && opts.install) throw new Error('A delegated worker cannot install provider runtimes');
    const cwd = resolve(context.cwd ?? process.cwd(), opts.cwd ?? '.');
    const directory = opts.directory ? resolve(cwd, opts.directory) : runtimeDirectory(cwd);
    if (opts.install && !opts.json) out.write('Checking for Antigravity ACP; downloading the official runtime if needed...\n');
    const result = opts.install ? await installAntigravityRuntime({ cwd, env, directory }) : findAntigravityRuntime({ cwd, env, directory });
    if (opts.json) out.write(JSON.stringify({ ...result, directory }) + '\n');
    else {
      out.write(`Antigravity ACP: ${result.status}${result.installed ? ' (installed)' : ''}\n`);
      if (result.binary) out.write(`Binary: ${result.binary}\n`);
      if (result.version) out.write(`Registry version: ${result.version}\n`);
      if (result.error) out.write(`Error: ${result.error}\n`);
      if (result.missing?.length) out.write(`Missing: ${result.missing.join(', ')}\n`);
      out.write(result.status === 'ready' ? 'Server/helper files are present. ACP connectivity, Google sign-in and model access still require a live check.\n' : 'Use acp-setup --install to download the official Windows runtime.\n');
      if (result.binary && result.status === 'ready') out.write('Set AGY_ACP_BINARY to this path when using a custom runtime directory.\n');
    }
    return result.status === 'ready' ? 0 : 1;
  } catch (error) { err.write(`error: ${error.message}\n`); return 1; }
}
