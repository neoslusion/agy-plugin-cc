import { runAntigravityAcp as runProvider } from './antigravity-acp.mjs';
import { findAntigravityRuntime } from '../antigravity-runtime.mjs';

export async function runAntigravityAcp(input, context = {}) {
  const env = context.env ?? process.env;
  if (input.options?.binary || env.AGY_ACP_BINARY) return runProvider(input, context);
  const runtime = findAntigravityRuntime({ cwd: context.cwd, env });
  if (runtime.status !== 'ready') throw new Error('Antigravity ACP runtime is unavailable. Run acp-setup --install, or set AGY_ACP_BINARY to a complete official runtime.');
  return runProvider({ ...input, options: { ...input.options, binary: runtime.binary } }, context);
}
