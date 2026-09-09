import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateRoot } from "./state.mjs";
import { workspaceSlug } from "./workspace.mjs";

export const BROKER_ENDPOINT_ENV = "AGY_COMPANION_APP_SERVER_ENDPOINT";
export const PID_FILE_ENV = "AGY_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "AGY_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

const PLUGIN_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export function createBrokerSessionDir(prefix = "agyc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");

  // Use the running Node executable rather than resolving "node" from PATH:
  // PATH may not carry node at all, or may resolve a different version than the
  // one running the plugin.
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env: {
      ...env,
      PATH: process.env.PATH
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  const dataRoot = process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), 'agy-companion');
  const stateRoot = resolveStateRoot(dataRoot, workspaceSlug(cwd));
  return path.join(stateRoot, BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      endpoint: data.endpoint ?? null,
      pid: data.pid ?? null,
      startedAt: data.startedAt ?? null,
      cwd: data.cwd ?? null,
      sessionDir: data.sessionDir ?? null
    };
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateFile = resolveBrokerStateFile(cwd);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(session, null, 2), "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export async function isBrokerAlive(session) {
  if (!session || !session.endpoint) {
    return false;
  }

  try {
    return await waitForBrokerEndpoint(session.endpoint, 500);
  } catch {
    return false;
  }
}

// A broker whose endpoint no longer answers may still be running (hung, or
// wedged before it started listening). Clearing state alone would leak that
// process, so reap the recorded pid before starting a replacement.
export function reapStaleBroker(session) {
  const pid = session?.pid;
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false; // already gone
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && await isBrokerAlive(existing)) {
    return existing;
  }

  // Clean up stale session, killing any orphaned process it left behind.
  if (existing) {
    reapStaleBroker(existing);
    clearBrokerSession(cwd);
  }

  // Create new broker session
  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath = path.join(PLUGIN_ROOT, "scripts", "agy-broker.mjs");

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const session = {
    endpoint,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    cwd,
    sessionDir
  };

  saveBrokerSession(cwd, session);

  // Wait for broker to be ready
  const ready = await waitForBrokerEndpoint(endpoint, 3000);
  if (!ready) {
    throw new Error(`Broker failed to start within 3s. Check log: ${logFile}`);
  }

  return session;
}
