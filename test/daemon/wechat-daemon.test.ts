import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildVisibleClientLaunchArgs,
  buildWindowsVisibleClientLaunchCommand,
  cleanupDaemonBeforeStart,
  cleanupSingleBridgeBeforeDaemon,
  defaultDaemonSessionStartMode,
  formatDaemonSwitchResultDetail,
  formatDaemonStatus,
  parseDaemonCliArgs,
  parseDaemonSwitchCommand,
  resolveDaemonSessionStartMode,
  waitForVisibleClientConnection,
} from "../../src/daemon/wechat-daemon.ts";
import type { BridgeLockPayload } from "../../src/bridge/bridge-state.ts";
import type {
  DaemonEndpoint,
  DaemonRequest,
} from "../../src/daemon/daemon-link.ts";

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

function buildDaemonEndpoint(overrides: Partial<DaemonEndpoint> = {}): DaemonEndpoint {
  return {
    protocolVersion: 1,
    pid: 28600,
    port: 55901,
    token: "daemon-token",
    cwd: "C:\\Users\\unlin",
    startedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("wechat-daemon helpers", () => {
  test("parseDaemonSwitchCommand recognizes terminal switch commands", () => {
    expect(parseDaemonSwitchCommand("/codex")).toBe("codex");
    expect(parseDaemonSwitchCommand("/claude")).toBe("claude");
    expect(parseDaemonSwitchCommand("/opencode")).toBe("opencode");
    expect(parseDaemonSwitchCommand("/pi")).toBe("pi");
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

  test("buildVisibleClientLaunchArgs routes Claude, OpenCode, and Pi through local companion", () => {
    for (const adapter of ["claude", "opencode", "pi"] as const) {
      const args = buildVisibleClientLaunchArgs({
        adapter,
        cwd: path.resolve("./tmp/project"),
      });

      expect(args.some((arg) => arg.endsWith("local-companion.ts"))).toBe(true);
      expect(args).toContain("--adapter");
      expect(args).toContain(adapter);
    }
  });

  test("buildVisibleClientLaunchArgs can request a fresh local companion session", () => {
    for (const adapter of ["claude", "opencode"] as const) {
      const args = buildVisibleClientLaunchArgs({
        adapter,
        cwd: path.resolve("./tmp/project"),
        sessionStartMode: "new",
      });

      expect(args).toContain("--session-start-mode");
      expect(args).toContain("new");
    }
  });

  test("defaultDaemonSessionStartMode restores Codex and Pi while starting Claude and OpenCode fresh", () => {
    expect(defaultDaemonSessionStartMode("codex")).toBe("restore");
    expect(defaultDaemonSessionStartMode("claude")).toBe("new");
    expect(defaultDaemonSessionStartMode("opencode")).toBe("new");
    expect(defaultDaemonSessionStartMode("pi")).toBe("restore");
  });

  test("resolveDaemonSessionStartMode avoids restoring stale OpenCode sessions", () => {
    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: true,
        visibleConnected: false,
      }),
    ).toBe("new");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: false,
        visibleConnected: false,
      }),
    ).toBe("new");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: false,
        visibleConnected: false,
        sharedSessionId: "session_current",
      }),
    ).toBe("restore");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: false,
        visibleConnected: true,
        sharedSessionId: "session_current",
      }),
    ).toBe("restore");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        explicitSessionStartMode: "new",
        slotCreated: false,
        visibleConnected: true,
        sharedSessionId: "session_current",
      }),
    ).toBe("new");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        explicitSessionStartMode: "new",
        slotCreated: false,
        visibleConnected: true,
        sharedSessionId: "session_current",
        reuseExistingVisible: true,
      }),
    ).toBe("restore");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "codex",
        slotCreated: true,
        visibleConnected: false,
      }),
    ).toBe("restore");
  });

  test("resolveDaemonSessionStartMode restores Pi when opening its first visible companion", () => {
    expect(
      resolveDaemonSessionStartMode({
        adapter: "pi",
        slotCreated: true,
        visibleConnected: false,
      }),
    ).toBe("restore");
  });

  test("buildWindowsVisibleClientLaunchCommand opens a titled console window", () => {
    const command = buildWindowsVisibleClientLaunchCommand({
      adapter: "claude",
      cwd: "D:\\work",
      args: ["C:\\Program Files\\bridge\\local-companion.js", "--cwd", "D:\\work"],
    });

    expect(command).toContain("start");
    expect(command).toContain('"wechat-claude"');
    expect(command).toContain('/D "D:\\work"');
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
    expect(
      formatDaemonStatus({
        cwd: "D:/work/project",
        activeAdapter: "pi",
        startedAt: "2026-05-22T00:00:00.000Z",
        slots: [],
      }),
    ).toContain("pi: not started");
  });

  test("formatDaemonSwitchResultDetail reports automatic visible CLI outcomes", () => {
    expect(
      formatDaemonSwitchResultDetail({
        created: true,
        openedVisible: true,
        visibleConnected: true,
      }),
    ).toBe("Started a new visible CLI.");

    expect(
      formatDaemonSwitchResultDetail({
        created: false,
        openedVisible: false,
        visibleConnected: true,
      }),
    ).toBe("Reused the existing visible CLI.");

    expect(
      formatDaemonSwitchResultDetail({
        created: true,
        openedVisible: true,
        visibleConnected: false,
        activated: false,
        previousActiveAdapter: "claude",
      }),
    ).toContain("Active terminal remains claude");
  });

  test("waitForVisibleClientConnection resolves when the visible companion appears", async () => {
    let now = 0;
    let checks = 0;

    const connected = await waitForVisibleClientConnection(
      {
        cwd: "D:\\work\\project",
        adapter: "opencode",
        timeoutMs: 1_000,
        pollMs: 250,
      },
      {
        isAlive: () => {
          checks += 1;
          return checks >= 3;
        },
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
    );

    expect(connected).toBe(true);
    expect(checks).toBe(3);
  });

  test("waitForVisibleClientConnection returns false on timeout", async () => {
    let now = 0;

    const connected = await waitForVisibleClientConnection(
      {
        cwd: "D:\\work\\project",
        adapter: "claude",
        timeoutMs: 500,
        pollMs: 250,
      },
      {
        isAlive: () => false,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
    );

    expect(connected).toBe(false);
    expect(now).toBe(500);
  });

  test("cleanupDaemonBeforeStart returns none when no daemon endpoint exists", async () => {
    await expect(
      cleanupDaemonBeforeStart({
        readEndpoint: () => null,
        listDaemonProcesses: () => [],
      }),
    ).resolves.toEqual({ action: "none" });
  });

  test("cleanupDaemonBeforeStart stops same-cwd daemon peers when no endpoint exists", async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101]);

    const result = await cleanupDaemonBeforeStart({
      cwd: "C:\\Users\\unlin",
      readEndpoint: () => null,
      listDaemonProcesses: (cwd) => {
        expect(cwd).toBe("C:\\Users\\unlin");
        return [
          {
            pid: 100,
            parentPid: 50,
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\unlin\\AppData\\Roaming\\npm\\node_modules\\cli-wechat-bridge\\bin\\wechat-daemon.mjs --cwd C:\\Users\\unlin',
          },
          {
            pid: 101,
            parentPid: 100,
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\dist\\daemon\\wechat-daemon.js --cwd C:\\Users\\unlin',
          },
        ];
      },
      killProcess: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
      forceStopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "none" });
    expect(killed).toEqual([101]);
  });

  test("cleanupDaemonBeforeStart clears stale daemon endpoint and workspace endpoints", async () => {
    const endpoint = buildDaemonEndpoint();
    const cleared: string[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => false,
      clearEndpoint: (pid) => {
        cleared.push(`endpoint:${pid ?? 0}`);
      },
      clearWorkspaceEndpoints: (payload) => {
        cleared.push(`workspace:${payload.cwd}`);
      },
      listDaemonProcesses: () => [],
      log: () => undefined,
      daemonLog: () => undefined,
    });

    expect(result).toEqual({ action: "cleared_stale_endpoint", endpoint });
    expect(cleared).toEqual(["workspace:C:\\Users\\unlin", "endpoint:28600"]);
  });

  test("cleanupDaemonBeforeStart gracefully stops a live daemon before startup", async () => {
    const endpoint = buildDaemonEndpoint();
    let alive = true;
    const requests: DaemonRequest[] = [];
    const cleared: string[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => alive,
      sendRequest: async (_endpoint, request) => {
        requests.push(request);
        alive = false;
        return { ok: true };
      },
      clearEndpoint: (pid) => {
        cleared.push(`endpoint:${pid ?? 0}`);
      },
      clearWorkspaceEndpoints: (payload) => {
        cleared.push(`workspace:${payload.cwd}`);
      },
      listDaemonProcesses: () => [],
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
    });

    expect(result).toEqual({ action: "stopped", endpoint, forced: false });
    expect(requests).toEqual([{ command: "shutdown" }]);
    expect(cleared).toEqual(["workspace:C:\\Users\\unlin", "endpoint:28600"]);
  });

  test("cleanupDaemonBeforeStart force-stops daemon endpoints that do not answer IPC", async () => {
    const endpoint = buildDaemonEndpoint();
    let alive = true;
    const killed: number[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => alive,
      sendRequest: async () => ({ ok: false, error: "Timed out waiting for daemon response." }),
      isDaemonProcess: () => true,
      killProcess: (pid) => {
        killed.push(pid);
        alive = false;
      },
      clearEndpoint: () => undefined,
      clearWorkspaceEndpoints: () => undefined,
      listDaemonProcesses: () => [],
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      log: () => undefined,
      daemonLog: () => undefined,
      stopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "stopped", endpoint, forced: true });
    expect(killed).toEqual([28600]);
  });

  test("cleanupDaemonBeforeStart does not force-stop unverified reused pids", async () => {
    const endpoint = buildDaemonEndpoint();
    const killed: number[] = [];
    const cleared: string[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => true,
      sendRequest: async () => ({ ok: false, error: "Daemon endpoint is not reachable." }),
      isDaemonProcess: () => false,
      killProcess: (pid) => {
        killed.push(pid);
      },
      clearEndpoint: (pid) => {
        cleared.push(`endpoint:${pid ?? 0}`);
      },
      clearWorkspaceEndpoints: (payload) => {
        cleared.push(`workspace:${payload.cwd}`);
      },
      listDaemonProcesses: () => [],
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
      stopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "cleared_stale_endpoint", endpoint });
    expect(killed).toEqual([]);
    expect(cleared).toEqual(["workspace:C:\\Users\\unlin", "endpoint:28600"]);
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
      daemonLog: () => undefined,
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
      daemonLog: () => undefined,
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
      daemonLog: () => undefined,
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
