import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcess } from './cli-process.mjs';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A provider may fail during initialization before its caller awaits the turn.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export class RpcProcess {
  constructor({ binary, args = [], cwd, env, timeoutMs = 30 * 60 * 1000, onNotification = () => {}, onRequest, onProgress = () => {}, onStderrLine, onFailure = () => {} }) {
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
    const script = /\.(mjs|cjs|js)$/i.test(binary);
    this.child = spawn(script ? process.execPath : binary, script ? [binary, ...args] : args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.fail = error => {
      if (this.closed) return;
      this.failure = error;
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
      onFailure(error);
      this.close();
    };
    const frame = line => {
      if (!line.trim()) return;
      let value;
      try { value = JSON.parse(line); }
      catch { this.fail(new Error('Provider sent invalid JSON-RPC (authenticate its server interactively first)')); return; }
      if (value.method) {
        if (value.id !== undefined) {
          Promise.resolve().then(() => onRequest?.(value.method, value.params, value.id)).then(result => {
            if (result === undefined) this.write({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Unsupported client request' } });
            else this.write({ jsonrpc: '2.0', id: value.id, result });
          }).catch(error => { this.write({ jsonrpc: '2.0', id: value.id, error: { code: -32603, message: error.message } }); });
        } else {
          try { onNotification(value.method, value.params); } catch (error) { this.fail(error); }
        }
      } else if (value.id !== undefined) {
        const entry = this.pending.get(value.id);
        if (!entry) return;
        this.pending.delete(value.id);
        if (value.error) entry.reject(new Error(`${entry.method}: ${value.error.message}`));
        else entry.resolve(value.result);
      }
    };
    this.child.once('spawn', () => onProgress({ type: 'spawn', pid: this.child.pid, binary }));
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.fail(new Error('Provider protocol frame exceeded 16 MiB')); return; }
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) frame(line);
    });
    this.child.stderr.on('data', chunk => { const text = chunk.toString('utf8'); this.stderr = (this.stderr + text).slice(-65536); onStderrLine?.(text); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('error', error => this.fail(error));
    this.child.once('close', code => { if (!this.closed) this.fail(new Error(`Provider exited before completion (exit ${code}): ${this.stderr.slice(-2000)}`)); });
    this.timer = setTimeout(() => this.fail(new Error(`Executor timed out after ${timeoutMs}ms`)), timeoutMs);
    this.signal = () => this.fail(new Error('Executor interrupted by parent'));
    process.once('SIGTERM', this.signal); process.once('SIGINT', this.signal);
  }
  write(value) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  notify(method, params = {}) { this.write({ jsonrpc: '2.0', method, params }); }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(this.failure ?? new Error('Provider session is closed'));
    const id = ++this.nextId, entry = deferred();
    this.pending.set(id, { ...entry, method });
    this.write({ jsonrpc: '2.0', id, method, params });
    return entry.promise;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    process.removeListener('SIGTERM', this.signal); process.removeListener('SIGINT', this.signal);
    for (const entry of this.pending.values()) entry.reject(this.failure ?? new Error('Provider session closed'));
    this.pending.clear();
    this.child.stdin.destroy();
    try { if (this.child.pid) terminateProcess(this.child.pid); } catch {}
  }
}
