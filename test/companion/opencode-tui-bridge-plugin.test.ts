import net from "node:net";

import { describe, expect, test } from "bun:test";

import opencodeTuiBridgePlugin from "../../src/companion/opencode-tui-bridge-plugin.ts";

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
