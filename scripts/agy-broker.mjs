#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { parseArgs } from "./lib/args.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

// The executor wraps node-script binaries (e.g. the fake-agy fixture) with the
// running Node executable; keep that behavior identical here so tests and
// AGY_BINARY overrides work against the broker too.
export function resolveBinaryLaunch(binaryName, args) {
  const isNodeScript = /\.(mjs|js|cjs)$/i.test(binaryName);
  return isNodeScript
    ? { cmd: process.execPath, args: [binaryName, ...args] }
    : { cmd: binaryName, args };
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/agy-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--binary <path>]");
  }

  const { opts } = parseArgs(argv, {
    extraValue: ['endpoint', 'cwd', 'pid-file', 'binary']
  });

  if (!opts.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();
  const endpoint = String(opts.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = opts["pid-file"] ? path.resolve(opts["pid-file"]) : null;
  const binaryName = opts.binary ?? process.env.AGY_BINARY ?? "agy";
  writePidFile(pidFile);

  const sockets = new Set();
  // Multi-tenant: one child per request. Runs are keyed by "<connId>#<json-rpc
  // id>" — raw ids are only unique per client (every client counts from 1), so
  // keying by id alone would collide across concurrent fan-out connections.
  const activeRuns = new Map(); // run key -> { socket, child, stdout, stderr }
  let nextConnId = 1;

  function killRun(run) {
    if (run.child && !run.child.killed) {
      run.child.kill();
    }
  }

  function cleanup() {
    for (const run of activeRuns.values()) {
      killRun(run);
    }
    activeRuns.clear();
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  function forwardEvents(socket, lines) {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt && typeof evt === "object" && evt.event) {
          send(socket, { method: "agy/notification", params: evt });
        }
      } catch {
        // Not valid JSON, ignore
      }
    }
  }

  function startRun(socket, runKey, replyId, args) {
    let launch;
    try {
      launch = resolveBinaryLaunch(binaryName, args);
    } catch {
      launch = { cmd: binaryName, args };
    }

    let child;
    try {
      child = spawn(launch.cmd, launch.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (err) {
      send(socket, {
        id: replyId,
        error: buildJsonRpcError(-32000, `Failed to spawn ${binaryName}: ${err.message}`)
      });
      return;
    }

    const run = { socket, child, stdout: "", stderr: "" };
    activeRuns.set(runKey, run);

    const outDecoder = new StringDecoder("utf8");
    let outLineBuf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = outDecoder.write(chunk);
      run.stdout += text;
      outLineBuf += text;
      const lines = outLineBuf.split("\n");
      outLineBuf = lines.pop();
      forwardEvents(socket, lines);
    });

    const errDecoder = new StringDecoder("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      run.stderr += errDecoder.write(chunk);
    });

    child.on("close", (exitCode) => {
      if (outLineBuf.trim()) {
        forwardEvents(socket, [outLineBuf]);
        outLineBuf = "";
      }
      // Client disconnected mid-run: nothing left to deliver.
      if (!activeRuns.has(runKey)) return;
      activeRuns.delete(runKey);
      send(socket, {
        id: replyId,
        result: {
          exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
          status: exitCode === 0 ? "completed" : "failed"
        }
      });
    });

    child.on("error", (err) => {
      if (!activeRuns.has(runKey)) return;
      activeRuns.delete(runKey);
      send(socket, {
        id: replyId,
        error: buildJsonRpcError(-32000, `Failed to spawn ${binaryName}: ${err.message}`)
      });
    });
  }

  const server = net.createServer((socket) => {
    const connId = nextConnId++;
    sockets.add(socket);
    socket.setEncoding("utf8");

    const decoder = new StringDecoder("utf8");
    let lineBuffer = "";

    socket.on("data", (chunk) => {
      lineBuffer += decoder.write(chunk);
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line);

          // Handle shutdown request
          if (message.method === "broker/shutdown") {
            send(socket, { id: message.id, result: { shutdown: true } });
            setTimeout(() => {
              cleanup();
              process.exit(0);
            }, 100);
            return;
          }

          // Handle agy/run request — concurrent runs are supported; each gets
          // its own child process and its own response.
          if (message.method === "agy/run") {
            if (message.id === undefined) {
              continue;
            }
            startRun(socket, `${connId}#${message.id}`, message.id, message.params?.args ?? []);
            continue;
          }

          // Unknown method
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(-32601, `Method not found: ${message.method}`)
          });
        } catch (err) {
          // Malformed JSON, ignore
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      // Kill only this client's runs; other clients' fan-out is unaffected.
      for (const [id, run] of activeRuns) {
        if (run.socket === socket) {
          activeRuns.delete(id);
          killRun(run);
        }
      }
    });

    socket.on("error", () => {
      // Ignore socket errors
    });
  });

  server.listen({ path: listenTarget.path }, () => {
    console.log(`Agy broker listening on ${endpoint}`);
  });
}

main().catch((err) => {
  console.error("Broker error:", err);
  process.exit(1);
});
