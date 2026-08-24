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

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await waitForTurn();
  }
  throw new Error("Timed out waiting for Pi adapter test state.");
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
  test("interrupts a WeChat turn when the local Pi TUI switches sessions", async () => {
    const adapter = new PiTuiAdapter({
      kind: "pi",
      command: "pi",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    const internal = adapter as unknown as {
      state: {
        status: string;
        activeTurnId?: string;
        activeTurnOrigin?: string;
        sharedSessionId?: string;
      };
      currentAssistantText: string;
      handleFrame(frame: Record<string, unknown>, socket: net.Socket): void;
    };
    internal.state.status = "busy";
    internal.state.activeTurnId = "pi-turn-old";
    internal.state.activeTurnOrigin = "wechat";
    internal.state.sharedSessionId = "pi-session-old";
    internal.currentAssistantText = "partial old answer";

    internal.handleFrame(
      {
        type: "session_state",
        sessionId: "pi-session-local",
        sessionFile: "C:\\pi\\local.jsonl",
      },
      {} as net.Socket,
    );

    const state = adapter.getState();
    expect(state).toEqual(
      expect.objectContaining({
        status: "idle",
        sharedSessionId: "pi-session-local",
      }),
    );
    expect(state.activeTurnId).toBeUndefined();
    expect(state.activeTurnOrigin).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_failed",
        message: expect.stringContaining("local Pi terminal switched sessions"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session_switched",
        sessionId: "pi-session-local",
        source: "local",
      }),
    );
  });

  test("keeps a slow native TUI alive while its extension is still loading", async () => {
    const child = new FakePiProcess();
    const killedPids: number[] = [];
    const adapter = new PiTuiAdapter(
      {
        kind: "pi",
        command: "pi",
        cwd: process.cwd(),
        renderMode: "companion",
      },
      {
        spawnProcess: (() => child) as never,
        killProcessTree: (pid) => killedPids.push(pid),
      },
    );

    await adapter.start();

    expect(adapter.getState()).toEqual(
      expect.objectContaining({
        pid: 4242,
        status: "starting",
      }),
    );
    expect(killedPids).toEqual([]);

    await adapter.dispose();
    expect(killedPids).toEqual([4242]);
  });

  test("inherits the visible terminal and forwards both WeChat and local final replies", async () => {
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
              `${JSON.stringify({ type: "hello", token: env.CLI_BRIDGE_PI_TUI_TOKEN })}\n`,
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
    await waitForCondition(() => adapter.getState().status === "idle");
    const eventCountBeforeSessionState = events.length;
    expect(adapter.getState()).toEqual(
      expect.objectContaining({
        kind: "pi",
        status: "idle",
      }),
    );
    expect(adapter.getState().sharedSessionId).toBeUndefined();
    extensionSocket?.write(
      `${JSON.stringify({
        type: "session_state",
        sessionId: "pi-session-live",
        sessionFile: "C:\\pi\\session.jsonl",
      })}\n`,
    );
    await waitForTurn();
    expect(events.length).toBeGreaterThan(eventCountBeforeSessionState);
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
    expect(events.filter((event) => event.type === "final_reply")).toEqual([
      expect.objectContaining({ text: "Done" }),
      expect.objectContaining({ text: "Local answer" }),
    ]);

    await adapter.dispose();
    extensionSocket?.destroy();
    expect(killedPids).toEqual([4242]);
  });

  test("resumes a verified same-workspace session through the visible extension", async () => {
    const cwd = makeTempDirectory();
    const sessionDir = makeTempDirectory();
    const sessionPath = path.join(sessionDir, "target.jsonl");
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session-target",
        cwd,
      })}\n`,
      "utf8",
    );
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;

    const child = new FakePiProcess();
    const commands: Array<Record<string, unknown>> = [];
    const events: BridgeEvent[] = [];
    let extensionSocket: net.Socket | null = null;
    const adapter = new PiTuiAdapter(
      {
        kind: "pi",
        command: "pi",
        cwd,
        renderMode: "companion",
      },
      {
        spawnProcess: ((_file: string, _args: string[], options: Record<string, unknown>) => {
          const env = options.env as Record<string, string>;
          const socket = net.connect({
            host: "127.0.0.1",
            port: Number(env.CLI_BRIDGE_PI_TUI_PORT),
          });
          extensionSocket = socket;
          socket.once("connect", () => {
            socket.write(
              `${JSON.stringify({ type: "hello", token: env.CLI_BRIDGE_PI_TUI_TOKEN })}\n`,
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
                  data: {
                    cancelled: false,
                    sessionId: "pi-session-target",
                    sessionFile: sessionPath,
                  },
                })}\n`,
              );
            },
            () => undefined,
          );
          return child;
        }) as never,
        killProcessTree: () => undefined,
      },
    );
    adapter.setEventSink((event) => events.push(event));

    try {
      await adapter.start();
      await waitForCondition(() => adapter.getState().status === "idle");
      extensionSocket?.write(
        `${JSON.stringify({
          type: "session_state",
          sessionId: "pi-session-current",
          sessionFile: path.join(sessionDir, "current.jsonl"),
        })}\n`,
      );
      await waitForCondition(
        () => adapter.getState().sharedSessionId === "pi-session-current",
      );

      await adapter.resumeSession("pi-session-target");

      expect(commands).toContainEqual(
        expect.objectContaining({
          type: "switch_session",
          sessionPath,
          sessionId: "pi-session-target",
          cwd,
        }),
      );
      expect(adapter.getState().sharedSessionId).toBe("pi-session-target");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session_switched",
          sessionId: "pi-session-target",
          source: "wechat",
          reason: "wechat_resume",
        }),
      );

      fs.rmSync(sessionPath);
      await expect(adapter.resumeSession("pi-session-target")).rejects.toThrow(
        "Pi session not found for this workspace",
      );
    } finally {
      await adapter.dispose();
      extensionSocket?.destroy();
      if (previousSessionDir === undefined) {
        delete process.env.PI_CODING_AGENT_SESSION_DIR;
      } else {
        process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      }
    }
  });
});
