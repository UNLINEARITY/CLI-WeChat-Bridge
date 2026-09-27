// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import net from "node:net";

import { describe, expect, test } from "bun:test";

import opencodeTuiBridgePlugin from "../../src/companion/opencode-tui-bridge-plugin.ts";
import opencodeV2TuiBridgePlugin from "../../src/companion/opencode-v2-tui-bridge-plugin.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for OpenCode TUI bridge plugin state.");
}

describe("OpenCode TUI bridge plugin", () => {
  test("reports the initial route and later local session switches", async () => {
    const frames: Array<Record<string, unknown>> = [];
    let buffer = "";
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) {
            return;
          }
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            frames.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("OpenCode plugin test server did not expose a port.");
    }

    let currentRoute: Record<string, unknown> = {
      name: "session",
      params: { sessionID: "ses_initial" },
    };
    let dispose = () => undefined;

    try {
      await opencodeTuiBridgePlugin.tui(
        {
          route: {
            get current() {
              return currentRoute;
            },
          },
          lifecycle: {
            onDispose(callback) {
              dispose = callback;
            },
          },
        },
        { port: address.port, token: "route-token" },
      );

      await waitFor(() => frames.some((frame) => frame.type === "route_state"));
      expect(frames).toContainEqual({ type: "hello", token: "route-token" });
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "route_state",
          sessionId: "ses_initial",
        }),
      );

      currentRoute = {
        name: "session",
        params: { sessionID: "ses_local_switch" },
      };
      await waitFor(() =>
        frames.some((frame) => frame.sessionId === "ses_local_switch"),
      );

      currentRoute = { name: "home" };
      await waitFor(() =>
        frames.some(
          (frame) => frame.type === "route_state" && frame.sessionId === null,
        ),
      );
    } finally {
      dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("OpenCode 2 TUI bridge plugin", () => {
  test("reports route changes and accepts remote session selection", async () => {
    const frames: Array<Record<string, unknown>> = [];
    let bridgeSocket: net.Socket | null = null;
    let buffer = "";
    const server = net.createServer((socket) => {
      bridgeSocket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) return;
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) frames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("OpenCode 2 plugin test server did not expose a port.");
    }

    let currentRoute: Record<string, unknown> = {
      type: "session",
      sessionID: "ses_initial",
    };
    const navigated: Array<Record<string, unknown>> = [];
    const dispose = opencodeV2TuiBridgePlugin.setup({
      options: { port: address.port, token: "route-token-v2" },
      ui: {
        router: {
          current: () => currentRoute,
          navigate: (destination) => {
            navigated.push(destination);
            currentRoute = destination;
          },
        },
      },
    });

    try {
      await waitFor(() => frames.some((frame) => frame.type === "route_state"));
      expect(frames).toContainEqual({ type: "hello", token: "route-token-v2" });
      expect(frames).toContainEqual(expect.objectContaining({
        type: "route_state",
        sessionId: "ses_initial",
      }));

      bridgeSocket!.write(`${JSON.stringify({
        type: "select_session",
        sessionId: "ses_remote",
      })}\n`);
      await waitFor(() => navigated.length === 1);
      expect(navigated).toEqual([{ type: "session", sessionID: "ses_remote" }]);
      await waitFor(() => frames.some((frame) => frame.sessionId === "ses_remote"));
    } finally {
      dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
