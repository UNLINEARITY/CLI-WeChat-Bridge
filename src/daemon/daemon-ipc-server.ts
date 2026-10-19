// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import net from "node:net";
import type { BridgeChannelId } from "../core/channel-types.ts";
import {
  attachDaemonRequestListener,
  buildDaemonToken,
  DAEMON_PROTOCOL_VERSION,
  sendDaemonResponse,
  writeDaemonEndpoint,
  type DaemonRequest,
} from "./daemon-link.ts";

const DAEMON_HOST = "127.0.0.1";

/** Loopback IPC endpoint for launchers and tools talking to a running daemon. */
export class DaemonIpcServer {
  private server: net.Server | null = null;
  private endpointToken = "";

  async start(params: {
    cwd: string;
    channelId: BridgeChannelId;
    startedAt: string;
    handle: (request: DaemonRequest) => Promise<unknown>;
  }): Promise<void> {
    this.endpointToken = buildDaemonToken();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        let detach: (() => void) | null = null;
        detach = attachDaemonRequestListener(socket, (frame) => {
          if (frame.token !== this.endpointToken) {
            sendDaemonResponse(socket, frame.id, {
              ok: false,
              error: "Invalid daemon IPC token.",
            });
            return;
          }

          void params.handle(frame.payload).then(
            (result) => {
              sendDaemonResponse(socket, frame.id, { ok: true, result });
            },
            (error) => {
              sendDaemonResponse(socket, frame.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
        });
        socket.once("close", () => {
          detach?.();
          detach = null;
        });
        socket.once("error", () => {
          socket.destroy();
        });
      });
      this.server = server;
      server.once("error", reject);
      server.listen(0, DAEMON_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate daemon IPC port."));
          return;
        }

        writeDaemonEndpoint({
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          pid: process.pid,
          port: address.port,
          token: this.endpointToken,
          cwd: params.cwd,
          startedAt: params.startedAt,
          channelId: params.channelId,
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
