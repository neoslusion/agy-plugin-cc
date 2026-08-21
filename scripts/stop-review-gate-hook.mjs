#!/usr/bin/env node
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveStateRoot, getConfig } from './lib/state.mjs';
import { workspaceSlug } from './lib/workspace.mjs';
import { loadPrompt, renderPrompt } from './lib/prompts.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function readPayload() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      try {
        process.stdin.pause();
        process.stdin.removeAllListeners();
      } catch {}
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    const fallback = setTimeout(finish, 2000);
  });
}

function lastAssistantMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const raw = readFileSync(transcriptPath, 'utf8');
  let last = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text) last = text;
    } else if (typeof content === 'string' && content) {
      last = content;
    }
  }
  return last;
}

function gateDecision(json) {
  const structured = json?.structuredOutput ?? json?.structured_output;
  if (structured?.decision === 'ALLOW') return { decision: 'allow' };
  if (structured?.decision === 'BLOCK') return { decision: 'block', reason: structured.reason ?? 'blocked by review gate' };
  const text = json?.response ?? '';
  const m = /^\s*(ALLOW|BLOCK):\s*(.*)$/m.exec(text);
  if (m) return m[1] === 'BLOCK' ? { decision: 'block', reason: m[2] } : { decision: 'allow' };
  return null;
}

async function main() {
  const payload = await readPayload();
  const env = process.env;
  const cwd = payload.cwd ?? process.cwd();
  const dataRoot = env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'agy-companion');
  const root = resolveStateRoot(dataRoot, workspaceSlug(cwd));

  if (payload.stop_hook_active === false || !getConfig(root).stopReviewGate) {
    return;
  }

  const lastMessage = payload.last_assistant_message ?? lastAssistantMessage(payload.transcript_path);
  if (!lastMessage) return;

  const prompt = renderPrompt(loadPrompt('stop-review-gate', PLUGIN_ROOT), { CLAUDE_RESPONSE_BLOCK: lastMessage });
  const companion = env.AGY_COMPANION_SCRIPT ?? join(PLUGIN_ROOT, 'scripts', 'agy-companion.mjs');
  const schemaPath = join(PLUGIN_ROOT, 'schemas', 'stop-gate.schema.json');
  const timeoutMs = Number(env.AGY_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const child = spawnSync(
    process.execPath,
    [companion, 'task', '--json', '--json-schema', schemaPath, prompt],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...env, AGY_SESSION_ID: payload.session_id ?? '', CLAUDE_PLUGIN_DATA: dataRoot },
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }
  );

  let json = null;
  try {
    json = JSON.parse(child.stdout ?? '');
  } catch {}
  const decision = gateDecision(json);
  if (decision?.decision === 'block') {
    const { writeSync } = await import('node:fs');
    writeSync(process.stdout.fd, JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
    return;
  }
  // ALLOW or any failure/timeout/parse error: fail open.
  if (child.status !== 0 && !json) {
    process.stderr.write(`stop-review-gate: companion failed (${child.status ?? 'timeout'}) — allowing stop\n`);
  }
}

await main();
process.exit(0);

// Watchdog: force-exit if anything (e.g. an inherited TTY stdin) keeps the
// event loop alive; the gate fails open anyway on cancellation.
setTimeout(() => process.exit(0), 3000).unref();
