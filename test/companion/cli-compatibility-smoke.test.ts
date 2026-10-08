// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  assertCodexSchemaCapabilities,
  waitForHealth,
} from "../../scripts/smoke-cli-compatibility.mjs";

const runningChild = { exitCode: null, signalCode: null };
const probeOptions = { timeoutMs: 1_000, probeTimeoutMs: 100, retryIntervalMs: 10 };

async function withServer(
  onRequest: (socket: net.Socket, attempt: number) => void,
  check: (url: string, attempts: () => number) => Promise<void>,
): Promise<void> {
  const sockets = new Set<net.Socket>();
  let attempts = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => onRequest(socket, ++attempts));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as net.AddressInfo;
    await check(`http://127.0.0.1:${address.port}/global/health`, () => attempts);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function reply(socket: net.Socket, body: string): void {
  socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

describe("CLI compatibility health probe", () => {
  for (const phase of ["headers", "body"]) {
    test(`retries when OpenCode accepts TCP but stalls its HTTP ${phase}`, async () => {
      await withServer((socket, attempt) => {
        if (attempt === 1) {
          if (phase === "body") {
            socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
          }
          return;
        }
        reply(socket, JSON.stringify({ healthy: true, version: "1.18.35" }));
      }, async (url, attempts) => {
        await waitForHealth(url, runningChild, undefined, probeOptions);
        expect(attempts()).toBeGreaterThanOrEqual(2);
      });
    });
  }

  test("bounds a permanently stalled server by the overall deadline", async () => {
    await withServer(() => {}, async (url) => {
      const started = Date.now();
      await expect(waitForHealth(url, runningChild, undefined, {
        ...probeOptions, timeoutMs: 200,
      })).rejects.toThrow("Timed out waiting for OpenCode health endpoint");
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  test("does not accept an HTML fallback or an unhealthy response as readiness", async () => {
    await withServer((socket, attempt) => {
      reply(socket, attempt === 1 ? "<html>booting</html>" : JSON.stringify({
        healthy: attempt > 2, version: "1.18.35",
      }));
    }, async (url, attempts) => {
      await waitForHealth(url, runningChild, undefined, probeOptions);
      expect(attempts()).toBe(3);
    });
  });

  test("accepts the OpenCode 2 info response without a healthy flag", async () => {
    await withServer((socket) => reply(socket, JSON.stringify({ version: "2.0.24" })), async (url) => {
      await waitForHealth(url.replace("/global/health", "/api/info"), runningChild, undefined, probeOptions);
    });
  });

  test("reports a signal-terminated server immediately", async () => {
    await expect(waitForHealth("http://127.0.0.1:1/global/health", {
      exitCode: null, signalCode: "SIGTERM",
    })).rejects.toThrow("OpenCode exited before health check (SIGTERM)");
  });
});

describe("Codex bridge protocol probe", () => {
  test("rejects generated schemas that omit a field the bridge uses", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-probe-"));
    fs.mkdirSync(path.join(directory, "v2"));
    fs.writeFileSync(path.join(directory, "v2/ThreadStartParams.json"), JSON.stringify({
      properties: { cwd: {}, approvalPolicy: {}, sandbox: {} },
    }));
    try {
      expect(() => assertCodexSchemaCapabilities(directory)).toThrow("approvalsReviewer");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
