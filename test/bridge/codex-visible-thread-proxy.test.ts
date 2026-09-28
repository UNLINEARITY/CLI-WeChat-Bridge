// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

import { CodexVisibleThreadProxy } from "../../src/bridge/codex-visible-thread-proxy.ts";

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

test("follows only successful visible-client thread openings", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  closeables.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: number; method: string };
      socket.send(JSON.stringify({
        id: request.id,
        ...(request.id === 3 ? { error: { message: "not found" } } : {
          result: { thread: {
            id: request.id === 2 ? "thread_new" : "thread_restored",
            cwd: "/workspace",
            ...(request.id === 5 ? { parentThreadId: "thread_parent" } : {}),
          } },
        }),
      }));
    });
  });
  const opened: string[] = [];
  const visibleTurns: string[] = [];
  const traces: string[] = [];
  const proxy = await CodexVisibleThreadProxy.start({
    upstreamUrl: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    token: "secret",
    onThreadOpened: (threadId) => opened.push(threadId),
    onVisibleTurn: (threadId) => visibleTurns.push(threadId),
    onTrace: (message) => traces.push(message),
  });
  closeables.unshift(() => proxy.close());

  const client = new WebSocket(proxy.url, { headers: { Authorization: "Bearer secret" } });
  await new Promise<void>((resolve) => client.once("open", resolve));
  expect(proxy.connected).toBe(true);
  const send = async (id: number, method: string): Promise<void> => {
    const reply = new Promise<void>((resolve) => client.once("message", () => resolve()));
    client.send(JSON.stringify({ id, method, params: { threadId: "thread_restored" } }));
    await reply;
  };
  await send(1, "thread/resume");
  await send(2, "thread/start");
  await send(3, "thread/resume");
  await send(4, "thread/read");
  await send(5, "thread/resume");
  const turnReply = new Promise<void>((resolve) => client.once("message", () => resolve()));
  client.send(JSON.stringify({ id: 6, method: "turn/start", params: { threadId: "thread_restored" } }));
  await turnReply;
  expect(visibleTurns).toEqual(["thread_restored"]);
  const unsolicited = new Promise<void>((resolve) => client.once("message", () => resolve()));
  for (const socket of upstream.clients) {
    socket.send(JSON.stringify({ id: 999, result: { thread: { id: "thread_invisible" } } }));
  }
  await unsolicited;
  expect(opened).toEqual(["thread_restored", "thread_new"]);
  expect(traces).toContain("request method=thread/resume thread=thread_resto");
  expect(traces).toContain("response method=thread/resume success=true");
  client.close();
});

test("rejects unauthenticated visible-client connections", async () => {
  const proxy = await CodexVisibleThreadProxy.start({
    upstreamUrl: "ws://127.0.0.1:1",
    token: "secret",
    onThreadOpened: () => {
      throw new Error("An unauthenticated client must not open a thread.");
    },
    onVisibleTurn: () => {
      throw new Error("An unauthenticated client must not start a turn.");
    },
  });
  closeables.push(() => proxy.close());
  const client = new WebSocket(proxy.url);
  const status = await new Promise<number>((resolve) => {
    client.once("unexpected-response", (_request, response) => resolve(response.statusCode));
  });
  expect(status).toBe(401);
  client.terminate();
});
