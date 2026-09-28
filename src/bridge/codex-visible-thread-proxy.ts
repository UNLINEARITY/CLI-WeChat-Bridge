// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

type VisibleThreadProxyOptions = {
  upstreamUrl: string;
  token: string;
  onThreadOpened: (threadId: string, cwd?: string) => void;
  onVisibleTurn: (threadId: string) => void;
  onTrace?: (message: string) => void;
};

export class CodexVisibleThreadProxy {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly upstreams = new Set<WebSocket>();

  private constructor(options: VisibleThreadProxyOptions) {
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        req.headers.authorization === `Bearer ${options.token}`,
    });
    this.server.on("connection", (client) => {
      options.onTrace?.("client_connected");
      const upstream = new WebSocket(options.upstreamUrl, {
        headers: { Authorization: `Bearer ${options.token}` },
      });
      this.clients.add(client);
      this.upstreams.add(upstream);
      const pendingRequests = new Map<string | number, string>();
      const queued: Array<{ data: Buffer; binary: boolean }> = [];
      let queuedBytes = 0;

      client.on("message", (data, binary) => {
        const bytes = Buffer.from(data as Buffer);
        if (!binary) {
          try {
            const request: unknown = JSON.parse(bytes.toString("utf8"));
            if (request && typeof request === "object" && "method" in request) {
              if (typeof request.method === "string" &&
                (request.method.startsWith("thread/") || request.method === "turn/start")) {
                const params = "params" in request && request.params && typeof request.params === "object"
                  ? request.params : null;
                const threadId = params && "threadId" in params && typeof params.threadId === "string"
                  ? params.threadId.slice(0, 12) : "none";
                options.onTrace?.(`request method=${request.method} thread=${threadId}`);
              }
              if (request.method === "turn/start" && "params" in request &&
                request.params && typeof request.params === "object" &&
                "threadId" in request.params && typeof request.params.threadId === "string") {
                options.onVisibleTurn(request.params.threadId);
              }
              if ((request.method === "thread/resume" || request.method === "thread/start") &&
                "id" in request && (typeof request.id === "number" || typeof request.id === "string")) {
                pendingRequests.set(request.id, request.method);
              }
            }
          } catch {
            // Forward non-JSON messages unchanged.
          }
        }
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(bytes, { binary });
        } else if (upstream.readyState === WebSocket.CONNECTING && queuedBytes + bytes.length <= 1_048_576) {
          queued.push({ data: bytes, binary });
          queuedBytes += bytes.length;
        } else {
          client.close();
        }
      });
      upstream.on("open", () => {
        for (const message of queued) upstream.send(message.data, { binary: message.binary });
        queued.length = 0;
      });
      upstream.on("message", (data, binary) => {
        if (!binary) {
          try {
            const response: unknown = JSON.parse(data.toString());
            const pendingMethod = response && typeof response === "object" && "id" in response &&
              (typeof response.id === "number" || typeof response.id === "string")
              ? pendingRequests.get(response.id) : undefined;
            if (pendingMethod && response && typeof response === "object" && "id" in response &&
              (typeof response.id === "number" || typeof response.id === "string")) {
              pendingRequests.delete(response.id);
              options.onTrace?.(`response method=${pendingMethod} success=${"result" in response}`);
            }
            if (pendingMethod && response && typeof response === "object" && "result" in response &&
              response.result && typeof response.result === "object" &&
              "thread" in response.result && response.result.thread &&
              typeof response.result.thread === "object" && "id" in response.result.thread &&
              typeof response.result.thread.id === "string" &&
              !("parentThreadId" in response.result.thread &&
                typeof response.result.thread.parentThreadId === "string") &&
              !("ephemeral" in response.result.thread && response.result.thread.ephemeral === true)) {
              const cwd = "cwd" in response.result.thread && typeof response.result.thread.cwd === "string"
                ? response.result.thread.cwd
                : undefined;
              options.onTrace?.(`opened thread=${response.result.thread.id.slice(0, 12)} cwd=${cwd ?? "unknown"}`);
              options.onThreadOpened(response.result.thread.id, cwd);
            }
          } catch {
            // A malformed response must not interrupt the visible client.
          }
        }
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      client.on("close", () => upstream.terminate());
      upstream.on("close", () => client.close());
      client.on("error", () => upstream.terminate());
      upstream.on("error", () => client.close());
      client.on("close", () => {
        this.clients.delete(client);
        options.onTrace?.("client_disconnected");
      });
      upstream.on("close", () => this.upstreams.delete(upstream));
    });
  }

  static async start(options: VisibleThreadProxyOptions): Promise<CodexVisibleThreadProxy> {
    const proxy = new CodexVisibleThreadProxy(options);
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.server.once("listening", resolve);
        proxy.server.once("error", reject);
      });
      return proxy;
    } catch (error) {
      proxy.server.close();
      throw error;
    }
  }

  get connected(): boolean {
    return this.clients.size > 0;
  }

  get url(): string {
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.terminate();
    for (const upstream of this.upstreams) upstream.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
