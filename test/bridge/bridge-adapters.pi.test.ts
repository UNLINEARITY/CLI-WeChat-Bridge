import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "bun:test";

import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import {
  attachPiTuiJsonlReader,
  buildPiSessionDirectory,
  buildPiTuiCliArgs,
  listPiResumeSessions,
  PiTuiAdapter,
} from "../../src/bridge/bridge-adapters.pi.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-pi-adapter-test-"));
  tempDirectories.push(directory);
  return directory;
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

class FakePiProcess extends EventEmitter {
  readonly pid = 4242;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("Pi adapter factory", () => {
  test("uses the local companion proxy on the bridge side", () => {
    const adapter = createBridgeAdapter({
      kind: "pi",
      command: "pi",
      cwd: process.cwd(),
    });

    expect(adapter).toBeInstanceOf(LocalCompanionProxyAdapter);
  });

  test("creates the native TUI adapter inside the visible companion", () => {
    const adapter = createBridgeAdapter({
      kind: "pi",
      command: "pi",
      cwd: process.cwd(),
      renderMode: "companion",
    });

    expect(adapter).toBeInstanceOf(PiTuiAdapter);
  });
});

describe("Pi TUI command line", () => {
  test("loads the bridge extension with project trust and restores the recent session", () => {
    expect(buildPiTuiCliArgs({ extensionPath: "C:\\bridge\\pi-extension.js" })).toEqual([
      "--approve",
      "--extension",
      "C:\\bridge\\pi-extension.js",
      "--continue",
    ]);
  });

  test("uses an exact saved session id when available", () => {
    expect(
      buildPiTuiCliArgs({
        extensionPath: "pi-extension.js",
        initialSessionId: "session-123",
      }),
    ).toEqual([
      "--approve",
      "--extension",
      "pi-extension.js",
      "--session-id",
      "session-123",
    ]);
  });

  test("starts a fresh session without restore flags", () => {
    const args = buildPiTuiCliArgs({
      extensionPath: "pi-extension.js",
      sessionStartMode: "new",
      extraCliArgs: ["--model", "openai/gpt-5.6-sol"],
    });

    expect(args).toEqual([
      "--approve",
      "--extension",
      "pi-extension.js",
      "--model",
      "openai/gpt-5.6-sol",
    ]);
    expect(args).not.toContain("--mode");
  });

  test("rejects flags that would replace bridge-owned TUI and session behavior", () => {
    expect(() =>
      buildPiTuiCliArgs({
        extensionPath: "pi-extension.js",
        extraCliArgs: ["--no-approve"],
      }),
    ).toThrow("Pi TUI runtime is managed by the WeChat bridge");
    expect(() =>
      buildPiTuiCliArgs({
        extensionPath: "pi-extension.js",
        extraCliArgs: ["--session-dir", "tmp"],
      }),
    ).toThrow("Pi TUI runtime is managed by the WeChat bridge");
  });
});

describe("Pi TUI framing", () => {
  test("splits only on LF and preserves Unicode separators inside JSON strings", () => {
    const stream = new PassThrough();
    const frames: Array<Record<string, unknown>> = [];
    const errors: Error[] = [];
    const detach = attachPiTuiJsonlReader(
      stream,
      (frame) => frames.push(frame),
      (error) => errors.push(error),
    );

    stream.write(`${JSON.stringify({ type: "message", text: "left\u2028right" })}\n`);

    expect(frames).toEqual([{ type: "message", text: "left\u2028right" }]);
    expect(errors).toEqual([]);
    detach();
  });
});

describe("Pi sessions", () => {
  test("uses Pi's encoded per-workspace session directory", () => {
    const cwd = path.join(path.parse(process.cwd()).root, "work", "robot");
    const agentDir = path.join(path.parse(process.cwd()).root, "pi-data");
    const directory = buildPiSessionDirectory(cwd, {
      PI_CODING_AGENT_DIR: agentDir,
    });
    const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

    expect(directory).toBe(path.join(path.resolve(agentDir), "sessions", safePath));
  });

  test("lists persistent Pi sessions for the current workspace", () => {
    const cwd = makeTempDirectory();
    const sessionDir = makeTempDirectory();
    const filePath = path.join(sessionDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session", version: 3, id: "pi-session-1", cwd }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Inspect the robot model" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    expect(
      listPiResumeSessions(cwd, 10, {
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
      }),
    ).toEqual([
      expect.objectContaining({
        sessionId: "pi-session-1",
        title: "Inspect the robot model",
        source: "pi",
      }),
    ]);
  });
});

describe("Pi TUI lifecycle", () => {
  test("inherits the visible terminal and forwards only WeChat-owned final replies", async () => {
    const child = new FakePiProcess();
    const events: BridgeEvent[] = [];
    const spawnCalls: Array<{
      file: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const killedPids: number[] = [];
    const commands: Array<Record<string, unknown>> = [];
    let extensionSocket: net.Socket | null = null;

    const adapter = new PiTuiAdapter(
      {
        kind: "pi",
        command: "pi",
        cwd: process.cwd(),
        renderMode: "companion",
      },
      {
        spawnProcess: ((file: string, args: string[], options: Record<string, unknown>) => {
          spawnCalls.push({ file, args, options });
          const env = options.env as Record<string, string>;
          const socket = net.connect({
            host: "127.0.0.1",
            port: Number(env.CLI_BRIDGE_PI_TUI_PORT),
          });
          extensionSocket = socket;
          socket.setEncoding("utf8");
          socket.once("connect", () => {
            socket.write(
              `${JSON.stringify({ type: "hello", token: env.CLI_BRIDGE_PI_TUI_TOKEN })}\n` +
                `${JSON.stringify({
                  type: "session_state",
                  sessionId: "pi-session-live",
                  sessionFile: "C:\\pi\\session.jsonl",
                })}\n`,
            );
          });
          attachPiTuiJsonlReader(
            socket,
            (frame) => {
              commands.push(frame);
              socket.write(
                `${JSON.stringify({
                  type: "response",
                  id: frame.id,
                  success: true,
                })}\n`,
              );
            },
            () => undefined,
          );
          return child;
        }) as never,
        killProcessTree: (pid) => killedPids.push(pid),
      },
    );
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    await adapter.sendInput("Check the workspace");
    extensionSocket?.write(
      `${JSON.stringify({
        type: "assistant_message",
        text: "Done",
        stopReason: "stop",
      })}\n` + `${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    await waitForTurn();

    const launchedCommand = [spawnCalls[0]?.file, ...(spawnCalls[0]?.args ?? [])].join(" ");
    expect(launchedCommand).toContain("--approve");
    expect(launchedCommand).toContain("--extension");
    expect(launchedCommand).not.toContain("--mode rpc");
    expect(spawnCalls[0]?.options).toEqual(
      expect.objectContaining({
        stdio: "inherit",
        windowsHide: false,
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "prompt", text: "Check the workspace" }),
    );
    expect(adapter.getState()).toEqual(
      expect.objectContaining({
        kind: "pi",
        status: "idle",
        sharedSessionId: "pi-session-live",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "final_reply",
        text: "Done",
      }),
    );

    extensionSocket?.write(
      `${JSON.stringify({ type: "local_input", text: "Local request" })}\n` +
        `${JSON.stringify({ type: "agent_start" })}\n` +
        `${JSON.stringify({ type: "assistant_message", text: "Local answer" })}\n` +
        `${JSON.stringify({ type: "agent_settled" })}\n`,
    );
    await waitForTurn();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "mirrored_user_input",
        text: "Local request",
      }),
    );
    expect(events.filter((event) => event.type === "final_reply")).toHaveLength(1);

    await adapter.dispose();
    extensionSocket?.destroy();
    expect(killedPids).toEqual([4242]);
  });
});
