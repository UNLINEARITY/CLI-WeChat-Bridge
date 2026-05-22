import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildVisibleClientLaunchArgs,
  buildWindowsVisibleClientLaunchCommand,
  cleanupSingleBridgeBeforeDaemon,
  formatDaemonStatus,
  parseDaemonCliArgs,
  parseDaemonSwitchCommand,
} from "../../src/daemon/wechat-daemon.ts";
import type { BridgeLockPayload } from "../../src/bridge/bridge-state.ts";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function buildBridgeLock(overrides: Partial<BridgeLockPayload> = {}): BridgeLockPayload {
  return {
    pid: 28544,
    parentPid: 1234,
    instanceId: "bridge-1",
    adapter: "codex",
    command: "codex",
    cwd: "C:\\Users\\unlin",
    startedAt: "2026-05-22T00:00:00.000Z",
    lifecycle: "persistent",
    ...overrides,
  };
}

describe("wechat-daemon helpers", () => {
  test("parseDaemonSwitchCommand recognizes terminal switch commands", () => {
    expect(parseDaemonSwitchCommand("/codex")).toBe("codex");
    expect(parseDaemonSwitchCommand("/claude")).toBe("claude");
    expect(parseDaemonSwitchCommand("/opencode")).toBe("opencode");
    expect(parseDaemonSwitchCommand("/status")).toBeNull();
  });

  test("parseDaemonCliArgs binds daemon to cwd and optional initial adapter", () => {
    const options = parseDaemonCliArgs([
      "--cwd",
      "./tmp/project",
      "--adapter",
      "claude",
      "--profile",
      "work",
      "--no-open",
    ]);

    expect(options).toEqual({
      cwd: path.resolve("./tmp/project"),
      initialAdapter: "claude",
      profile: "work",
      openVisible: false,
    });
  });

  test("buildVisibleClientLaunchArgs routes codex through the remote client", () => {
    const args = buildVisibleClientLaunchArgs({
      adapter: "codex",
      cwd: path.resolve("./tmp/project"),
      cliArgs: ["--yolo"],
    });

    expect(args.some((arg) => arg.endsWith("codex-remote-client.ts"))).toBe(true);
    expect(args).toContain("--cwd");
    expect(args).toContain(path.resolve("./tmp/project"));
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--adapter");
  });

  test("buildVisibleClientLaunchArgs routes Claude and OpenCode through local companion", () => {
    const args = buildVisibleClientLaunchArgs({
      adapter: "opencode",
      cwd: path.resolve("./tmp/project"),
    });

    expect(args.some((arg) => arg.endsWith("local-companion.ts"))).toBe(true);
    expect(args).toContain("--adapter");
    expect(args).toContain("opencode");
  });

  test("buildWindowsVisibleClientLaunchCommand opens a titled console window", () => {
    const command = buildWindowsVisibleClientLaunchCommand({
      adapter: "claude",
      args: ["C:\\Program Files\\bridge\\local-companion.js", "--cwd", "D:\\work"],
    });

    expect(command).toContain("start");
    expect(command).toContain('"wechat-claude"');
    expect(command).toContain('"C:\\Program Files\\bridge\\local-companion.js"');
  });

  test("formatDaemonStatus lists active adapter and all daemon slots", () => {
    expect(
      formatDaemonStatus({
        cwd: "D:/work/project",
        activeAdapter: "codex",
        startedAt: "2026-05-22T00:00:00.000Z",
        slots: [
          {
            adapter: "codex",
            status: "idle",
            cwd: "D:/work/project",
            companionPid: 456,
            pendingApproval: false,
            pendingUserInput: false,
          },
          {
            adapter: "claude",
            status: "awaiting_approval",
            cwd: "D:/work/project",
            pendingApproval: true,
            pendingUserInput: false,
          },
        ],
      }),
    ).toContain("active: codex");
  });

  test("cleanupSingleBridgeBeforeDaemon returns none when no lock exists", async () => {
    await expect(
      cleanupSingleBridgeBeforeDaemon({
        readLock: () => null,
      }),
    ).resolves.toEqual({ action: "none" });
  });

  test("cleanupSingleBridgeBeforeDaemon clears stale locks and endpoints", async () => {
    const lock = buildBridgeLock();
    const cleared: string[] = [];

    const result = await cleanupSingleBridgeBeforeDaemon({
      readLock: () => lock,
      isAlive: () => false,
      clearEndpoint: (payload) => {
        cleared.push(`endpoint:${payload.adapter}:${payload.cwd}`);
      },
      clearLock: (payload) => {
        cleared.push(`lock:${payload.pid}`);
      },
      log: () => undefined,
    });

    expect(result).toEqual({ action: "cleared_stale_lock", lock });
    expect(cleared).toEqual([
      "endpoint:codex:C:\\Users\\unlin",
      "lock:28544",
    ]);
  });

  test("cleanupSingleBridgeBeforeDaemon stops a live single bridge before daemon startup", async () => {
    const lock = buildBridgeLock({ adapter: "opencode" });
    let alive = true;
    const signals: string[] = [];
    const cleared: string[] = [];

    const result = await cleanupSingleBridgeBeforeDaemon({
      readLock: () => lock,
      isAlive: () => alive,
      killProcess: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      clearEndpoint: (payload) => {
        cleared.push(`endpoint:${payload.adapter}`);
      },
      clearLock: (payload) => {
        cleared.push(`lock:${payload.pid}`);
      },
      sleep: async () => undefined,
      log: () => undefined,
    });

    expect(result).toEqual({ action: "stopped", lock, forced: false });
    expect(signals).toEqual(["SIGTERM"]);
    expect(cleared).toEqual(["endpoint:opencode", "lock:28544"]);
  });

  test("cleanupSingleBridgeBeforeDaemon force-stops bridges that ignore SIGTERM", async () => {
    const lock = buildBridgeLock();
    let alive = true;
    const signals: string[] = [];
    let pollCount = 0;

    const result = await cleanupSingleBridgeBeforeDaemon({
      readLock: () => lock,
      isAlive: () => {
        pollCount += 1;
        return alive;
      },
      killProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
      clearEndpoint: () => undefined,
      clearLock: () => undefined,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      log: () => undefined,
      stopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "stopped", lock, forced: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pollCount).toBeGreaterThan(1);
  });

  test("package exposes the daemon binary and npm script", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const binSource = readRepoFile("bin/wechat-daemon.mjs");

    expect(packageJson.bin?.["wechat-daemon"]).toBe("bin/wechat-daemon.mjs");
    expect(packageJson.scripts?.daemon).toContain("src/daemon/wechat-daemon.ts");
    expect(binSource).toContain('runJsEntry("dist/daemon/wechat-daemon.js")');
  });
});
