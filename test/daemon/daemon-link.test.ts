import { describe, expect, test } from "bun:test";
import net from "node:net";

import {
  isPidAlive,
  sendDaemonRequest,
  type DaemonEndpoint,
  type DaemonRequest,
} from "../../src/daemon/daemon-link.ts";

describe("daemon-link isPidAlive", () => {
  test("rejects invalid pids", () => {
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  test("returns true when process.kill succeeds", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("treats EPERM as alive (process exists under another privilege level)", () => {
    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;
    try {
      expect(isPidAlive(4321)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  test("treats ESRCH as dead", () => {
    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }) as typeof process.kill;
    try {
      expect(isPidAlive(4321)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });

  test("sends external text and input IPC requests", async () => {
    const received: DaemonRequest[] = [];
    const token = "test-token";
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) return;
        const line = buffer.slice(0, newlineIndex);
        const frame = JSON.parse(line) as {
          id: string;
          token: string;
          payload: DaemonRequest;
        };
        expect(frame.token).toBe(token);
        received.push(frame.payload);
        socket.write(`${JSON.stringify({ id: frame.id, response: { ok: true, result: { accepted: true } } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind a TCP port");
    }
    const endpoint: DaemonEndpoint = {
      protocolVersion: 1,
      pid: process.pid,
      port: address.port,
      token,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    };

    try {
      await expect(
        sendDaemonRequest(endpoint, {
          command: "send_text",
          recipientId: "owner",
          conversationId: "chat-1",
          text: "hello",
          context: "xiantong",
        }),
      ).resolves.toEqual({ ok: true, result: { accepted: true } });
      await expect(
        sendDaemonRequest(endpoint, {
          command: "forward_input",
          adapter: "codex",
          cwd: process.cwd(),
          senderId: "owner",
          conversationId: "chat-1",
          text: "prompt",
        }),
      ).resolves.toEqual({ ok: true, result: { accepted: true } });
    } finally {
      server.close();
    }

    expect(received).toEqual([
      {
        command: "send_text",
        recipientId: "owner",
        conversationId: "chat-1",
        text: "hello",
        context: "xiantong",
      },
      {
        command: "forward_input",
        adapter: "codex",
        cwd: process.cwd(),
        senderId: "owner",
        conversationId: "chat-1",
        text: "prompt",
      },
    ]);
  });
});
