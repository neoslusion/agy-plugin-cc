import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession } from "./broker-lifecycle.mjs";

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = new Error(message);
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

export class AgyBrokerClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.exitPromise = null;
    this.resolveExit = null;
  }

  async connect() {
    if (this.socket) {
      throw new Error("AgyBrokerClient is already connected.");
    }

    const target = parseBrokerEndpoint(this.endpoint);
    this.socket = net.createConnection({ path: target.path });
    this.socket.setEncoding("utf8");

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.socket.on("data", (chunk) => {
      this.lineBuffer += this.decoder.write(chunk);
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          this.handleLine(line);
        }
      }
    });

    this.socket.on("error", (err) => {
      if (!this.closed) {
        this.exitError = err;
      }
    });

    this.socket.on("close", () => {
      this.closed = true;
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error("Connection closed before response received"));
      }
      this.pending.clear();
      if (this.resolveExit) {
        this.resolveExit();
      }
    });

    // Wait for connection
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  handleLine(line) {
    try {
      const message = JSON.parse(line);

      // Response to a request
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);

        if (message.error) {
          reject(createProtocolError(message.error.message ?? "RPC error", message.error));
        } else {
          resolve(message.result ?? {});
        }
        return;
      }

      // Notification
      if (message.method && this.notificationHandler) {
        this.notificationHandler(message);
      }
    } catch (err) {
      // Ignore malformed JSON
    }
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request(method, params = {}) {
    if (this.closed) {
      throw new Error("AgyBrokerClient is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  sendMessage(message) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }

    if (this.exitPromise) {
      await this.exitPromise;
    }
  }

  static async connect(cwd, options = {}) {
    const session = options.session ?? await ensureBrokerSession(cwd, options);
    const client = new AgyBrokerClient(session.endpoint);
    await client.connect();
    return client;
  }
}
