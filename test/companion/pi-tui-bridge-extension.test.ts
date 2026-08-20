import { describe, expect, test } from "bun:test";
import net from "node:net";

import piTuiBridgeExtension from "../../src/companion/pi-tui-bridge-extension.ts";

type PiExtensionApi = Parameters<typeof piTuiBridgeExtension>[0];
type PiEventHandler = Parameters<PiExtensionApi["on"]>[1];
type PiExtensionContext = Parameters<PiEventHandler>[1];

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Pi extension test state.");
}

describe("Pi TUI bridge extension", () => {
  test("queues bridge commands until Pi publishes its session context", async () => {
    const handlers = new Map<string, PiEventHandler>();
    const sentMessages: string[] = [];
    const frames: Record<string, unknown>[] = [];
    let clientSocket: net.Socket | null = null;
    let buffer = "";

    const server = net.createServer((socket) => {
      clientSocket = socket;
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
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Pi extension test server did not expose a TCP port.");
    }

    const previousPort = process.env.CLI_BRIDGE_PI_TUI_PORT;
    const previousToken = process.env.CLI_BRIDGE_PI_TUI_TOKEN;
    process.env.CLI_BRIDGE_PI_TUI_PORT = String(address.port);
    process.env.CLI_BRIDGE_PI_TUI_TOKEN = "test-token";

    const context: PiExtensionContext = {
      isIdle: () => true,
      abort: () => undefined,
      sessionManager: {
        getSessionId: () => "pi-session-new",
        getSessionFile: () => "C:\\pi\\session.jsonl",
      },
      newSession: async (options) => {
        await options?.withSession?.(context);
        return { cancelled: false };
      },
      switchSession: async (_sessionPath, options) => {
        await options?.withSession?.(context);
        return { cancelled: false };
      },
    };

    try {
      piTuiBridgeExtension({
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: () => undefined,
        sendUserMessage: (content) => sentMessages.push(content),
      });

      await waitFor(() => frames.some((frame) => frame.type === "hello"));
      clientSocket?.write(
        `${JSON.stringify({ id: "prompt-1", type: "prompt", text: "hello" })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(sentMessages).toEqual([]);
      expect(frames.some((frame) => frame.id === "prompt-1")).toBe(false);

      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      await sessionStart?.({ reason: "startup" }, context);

      await waitFor(() => frames.some((frame) => frame.id === "prompt-1"));
      expect(sentMessages).toEqual(["hello"]);
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "response",
          id: "prompt-1",
          success: true,
        }),
      );
    } finally {
      clientSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousPort === undefined) {
        delete process.env.CLI_BRIDGE_PI_TUI_PORT;
      } else {
        process.env.CLI_BRIDGE_PI_TUI_PORT = previousPort;
      }
      if (previousToken === undefined) {
        delete process.env.CLI_BRIDGE_PI_TUI_TOKEN;
      } else {
        process.env.CLI_BRIDGE_PI_TUI_TOKEN = previousToken;
      }
    }
  });
});
