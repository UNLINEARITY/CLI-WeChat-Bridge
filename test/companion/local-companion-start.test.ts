import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildBackgroundBridgeArgs,
  decideLaunchAction,
  ensureCompanionStartWechatCredentials,
  formatAlreadyActiveMessage,
  formatRestartUnhealthyMessage,
  formatSwitchFailureMessage,
  formatSwitchMessage,
  isSameWorkspaceCwd,
  normalizeComparablePath,
  parseCliArgs,
  runVisibleClient,
  tryDelegateToDaemon,
} from "../../src/companion/local-companion-start.ts";
import type {
  DaemonEndpoint,
  DaemonRequest,
} from "../../src/daemon/daemon-link.ts";

describe("local-companion-start helpers", () => {
  test("parseCliArgs uses current working directory by default", () => {
    const options = parseCliArgs([]);
    expect(options.adapter).toBe("codex");
    expect(options.cwd).toBe(process.cwd());
    expect(options.timeoutMs).toBe(15000);
    expect(options.sessionStartMode).toBe("restore");
    expect(options.cliArgs).toEqual([]);
  });

  test("parseCliArgs parses adapter, cwd, profile, timeout, and forwarded args", () => {
    const options = parseCliArgs([
      "--adapter",
      "claude",
      "--cwd",
      "./tmp/project",
      "--model",
      "sonnet",
      "--profile",
      "work",
      "--timeout-ms",
      "25000",
      "--dangerously-skip-permissions",
    ]);

    expect(options.adapter).toBe("claude");
    expect(options.cwd).toBe(path.resolve("./tmp/project"));
    expect(options.profile).toBe("work");
    expect(options.timeoutMs).toBe(25000);
    expect(options.sessionStartMode).toBe("new");
    expect(options.cliArgs).toEqual([
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
    ]);
  });

  test("parseCliArgs accepts Pi and forwards model options", () => {
    const options = parseCliArgs([
      "--adapter",
      "pi",
      "--model",
      "openai/gpt-5.6-sol",
    ]);

    expect(options.adapter).toBe("pi");
    expect(options.sessionStartMode).toBe("restore");
    expect(options.cliArgs).toEqual(["--model", "openai/gpt-5.6-sol"]);
  });

  test("buildBackgroundBridgeArgs binds codex background bridge to the launcher lifetime", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "codex",
      cwd: path.resolve("./tmp/project"),
      profile: "work",
      timeoutMs: 15000,
      sessionStartMode: "restore",
      cliArgs: [],
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "codex",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
      "--profile",
      "work",
    ]);
  });

  test("buildBackgroundBridgeArgs can launch claude in the background", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "claude",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
      sessionStartMode: "new",
      cliArgs: [],
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "claude",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
      "--session-start-mode",
      "new",
    ]);
  });

  test("buildBackgroundBridgeArgs keeps the OpenCode bridge companion_bound", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "opencode",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
      sessionStartMode: "new",
      cliArgs: [],
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "opencode",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
      "--session-start-mode",
      "new",
    ]);
  });

  test("buildBackgroundBridgeArgs runs compiled bridge entries without TypeScript stripping", () => {
    const args = buildBackgroundBridgeArgs("/tmp/dist/bridge/wechat-bridge.js", {
      adapter: "codex",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
      sessionStartMode: "restore",
      cliArgs: [],
    });

    expect(args).toEqual([
      "--no-warnings",
      "/tmp/dist/bridge/wechat-bridge.js",
      "--adapter",
      "codex",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
    ]);
  });

  test("runVisibleClient routes codex through the in-process remote client", async () => {
    const calls: Array<{ cwd: string }> = [];
    const exitCode = await runVisibleClient(
      {
        adapter: "codex",
        cwd: path.resolve("./tmp/project"),
        timeoutMs: 15000,
        sessionStartMode: "restore",
        cliArgs: ["--yolo"],
      },
      {
        codexRemoteClient: async (options) => {
          calls.push(options);
          return 7;
        },
        localCompanion: async () => {
          throw new Error("local companion should not be used for codex");
        },
      },
    );

    expect(exitCode).toBe(7);
    expect(calls).toEqual([
      {
        cwd: path.resolve("./tmp/project"),
        cliArgs: ["--yolo"],
      },
    ]);
  });

  test("starter checks WeChat credentials in the foreground before opening the client", async () => {
    const calls: Array<{
      requireUserId?: boolean;
      validateExisting?: boolean;
      logType: string;
    }> = [];

    await ensureCompanionStartWechatCredentials("codex", async (options) => {
      calls.push({
        requireUserId: options!.requireUserId,
        validateExisting: options!.validateExisting,
        logType: typeof options!.log,
      });
      return {
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "owner@im.wechat",
        savedAt: "2026-05-10T00:00:00.000Z",
      };
    });

    expect(calls).toEqual([
      {
        requireUserId: true,
        validateExisting: true,
        logType: "function",
      },
    ]);
  });

  test("tryDelegateToDaemon asks a live same-cwd daemon to ensure the requested slot", async () => {
    const cwd = path.resolve("./tmp/project");
    const endpoint: DaemonEndpoint = {
      protocolVersion: 1,
      pid: 123,
      port: 9123,
      token: "token",
      cwd,
      startedAt: "2026-05-22T00:00:00.000Z",
    };
    const requests: DaemonRequest[] = [];

    const delegated = await tryDelegateToDaemon(
      {
        adapter: "opencode",
        cwd,
        profile: "work",
        timeoutMs: 15000,
        sessionStartMode: "new",
        cliArgs: ["--mode", "build"],
      },
      {
        readEndpoint: () => endpoint,
        isEndpointAlive: async () => true,
        sendRequest: async (_endpoint, request) => {
          requests.push(request);
          return { ok: true };
        },
      },
    );

    expect(delegated).toBe(true);
    expect(requests).toEqual([
      {
        command: "ensure_slot",
        adapter: "opencode",
        cwd,
        profile: "work",
        cliArgs: ["--mode", "build"],
        openVisible: true,
        sessionStartMode: "new",
        reuseExistingVisible: true,
      },
    ]);
  });

  test("tryDelegateToDaemon rejects daemon cwd mismatches", async () => {
    const endpoint: DaemonEndpoint = {
      protocolVersion: 1,
      pid: 123,
      port: 9123,
      token: "token",
      cwd: "D:/work/project-a",
      startedAt: "2026-05-22T00:00:00.000Z",
    };

    await expect(
      tryDelegateToDaemon(
        {
          adapter: "codex",
          cwd: "D:/work/project-b",
          timeoutMs: 15000,
          sessionStartMode: "restore",
          cliArgs: [],
        },
        {
          readEndpoint: () => endpoint,
          isEndpointAlive: async () => true,
        },
      ),
    ).rejects.toThrow("v1 daemon switching is limited to its startup cwd");
  });

  test("tryDelegateToDaemon clears stale daemon endpoint and falls back", async () => {
    const endpoint: DaemonEndpoint = {
      protocolVersion: 1,
      pid: 123,
      port: 9123,
      token: "token",
      cwd: path.resolve("./tmp/project"),
      startedAt: "2026-05-22T00:00:00.000Z",
    };
    const cleared: number[] = [];

    const delegated = await tryDelegateToDaemon(
      {
        adapter: "codex",
        cwd: endpoint.cwd,
        timeoutMs: 15000,
        sessionStartMode: "restore",
        cliArgs: [],
      },
      {
        readEndpoint: () => endpoint,
        isEndpointAlive: async () => false,
        clearEndpoint: (pid) => {
          cleared.push(pid ?? 0);
        },
      },
    );

    expect(delegated).toBe(false);
    expect(cleared).toEqual([123]);
  });

  test("runVisibleClient routes OpenCode through the shared in-process companion", async () => {
    const calls: Array<{ adapter: string; cwd: string }> = [];
    const exitCode = await runVisibleClient(
      {
        adapter: "opencode",
        cwd: path.resolve("./tmp/project"),
        timeoutMs: 15000,
        sessionStartMode: "new",
        cliArgs: ["--mode", "build"],
      },
      {
        codexRemoteClient: async () => {
          throw new Error("codex remote client should not be used for opencode");
        },
        localCompanion: async (options) => {
          calls.push(options);
          return 9;
        },
      },
    );

    expect(exitCode).toBe(9);
    expect(calls).toEqual([
      {
        adapter: "opencode",
        cwd: path.resolve("./tmp/project"),
        sessionStartMode: "new",
        cliArgs: ["--mode", "build"],
      },
    ]);
  });

  test("runVisibleClient routes Pi through the shared in-process companion", async () => {
    const calls: Array<{ adapter: string; cwd: string }> = [];
    const exitCode = await runVisibleClient(
      {
        adapter: "pi",
        cwd: path.resolve("./tmp/project"),
        timeoutMs: 15000,
        sessionStartMode: "restore",
        cliArgs: ["--model", "openai/gpt-5.6-sol"],
      },
      {
        codexRemoteClient: async () => {
          throw new Error("codex remote client should not be used for pi");
        },
        localCompanion: async (options) => {
          calls.push(options);
          return 7;
        },
      },
    );

    expect(exitCode).toBe(7);
    expect(calls).toEqual([
      {
        adapter: "pi",
        cwd: path.resolve("./tmp/project"),
        sessionStartMode: "restore",
        cliArgs: ["--model", "openai/gpt-5.6-sol"],
      },
    ]);
  });

  test("runVisibleClient keeps adapter forwarding for local companions", async () => {
    const calls: Array<{ adapter: string; cwd: string }> = [];
    const exitCode = await runVisibleClient(
      {
        adapter: "claude",
        cwd: path.resolve("./tmp/project"),
        timeoutMs: 15000,
        sessionStartMode: "new",
        cliArgs: ["--debug"],
      },
      {
        codexRemoteClient: async () => {
          throw new Error("codex remote client should not be used for claude");
        },
        localCompanion: async (options) => {
          calls.push(options);
          return 11;
        },
      },
    );

    expect(exitCode).toBe(11);
    expect(calls).toEqual([
      {
        adapter: "claude",
        cwd: path.resolve("./tmp/project"),
        sessionStartMode: "new",
        cliArgs: ["--debug"],
      },
    ]);
  });

  test("buildBackgroundBridgeArgs keeps the launch cwd stable for codex", () => {
    const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.ts", {
      adapter: "codex",
      cwd: path.resolve("./tmp/project"),
      timeoutMs: 15000,
      sessionStartMode: "restore",
      cliArgs: [],
    });

    expect(args).toEqual([
      "--no-warnings",
      "--experimental-strip-types",
      "/tmp/wechat-bridge.ts",
      "--adapter",
      "codex",
      "--cwd",
      path.resolve("./tmp/project"),
      "--lifecycle",
      "companion_bound",
    ]);
  });

  test("normalizeComparablePath is stable for the same logical cwd", () => {
    const first = normalizeComparablePath(".");
    const second = normalizeComparablePath(process.cwd());
    expect(first).toBe(second);
  });

  test("isSameWorkspaceCwd matches equivalent directory paths", () => {
    expect(isSameWorkspaceCwd(".", process.cwd())).toBe(true);
  });

  test("same workspace with live visible client is already active", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "codex",
      requestedCwd: "D:/work/project",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "codex",
        command: "codex",
        cwd: "D:/work/project",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "companion_bound",
      },
      lockShouldAutoReclaim: false,
      endpoint: {
        protocolVersion: 2,
        runtimeKind: "codex_runtime_host",
        instanceId: "bridge-1",
        kind: "codex",
        port: 8123,
        token: "token",
        cwd: "D:/work/project",
        command: "codex",
        startedAt: "2026-03-28T00:01:00.000Z",
        companionPid: 456,
        companionConnectedAt: "2026-03-28T00:02:00.000Z",
        companionStatus: "idle",
      },
      endpointIsReachable: true,
      companionIsAlive: true,
      sessionStartMode: "restore",
    });

    expect(decision).toEqual({
      kind: "already_active",
      message: formatAlreadyActiveMessage("D:/work/project"),
    });
  });

  test("same workspace reopens visible client when bridge is alive but client is gone", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "codex",
      requestedCwd: "D:/work/project",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "codex",
        command: "codex",
        cwd: "D:/work/project",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "companion_bound",
      },
      lockShouldAutoReclaim: false,
      endpoint: {
        protocolVersion: 2,
        runtimeKind: "codex_runtime_host",
        instanceId: "bridge-1",
        kind: "codex",
        port: 8123,
        token: "token",
        cwd: "D:/work/project",
        command: "codex",
        startedAt: "2026-03-28T00:01:00.000Z",
      },
      endpointIsReachable: true,
      companionIsAlive: false,
      sessionStartMode: "restore",
    });

    expect(decision).toEqual({
      kind: "open_companion",
      message: "Found running bridge for D:/work/project. Opening companion...",
    });
  });

  test("same workspace with no reachable endpoint requests auto-heal restart", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "codex",
      requestedCwd: "D:/work/project",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "codex",
        command: "codex",
        cwd: "D:/work/project",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "persistent",
      },
      lockShouldAutoReclaim: false,
      endpoint: null,
      endpointIsReachable: false,
      companionIsAlive: false,
      sessionStartMode: "restore",
    });

    expect(decision).toEqual({
      kind: "restart_unhealthy",
      message: formatRestartUnhealthyMessage("D:/work/project"),
    });
  });

  test("different workspace requests an explicit switch", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "codex",
      requestedCwd: "D:/work/project-b",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "codex",
        command: "codex",
        cwd: "D:/work/project-a",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "companion_bound",
      },
      lockShouldAutoReclaim: false,
      endpoint: null,
      endpointIsReachable: false,
      companionIsAlive: false,
      sessionStartMode: "restore",
    });

    expect(decision).toEqual({
      kind: "switch_workspace",
      fromCwd: "D:/work/project-a",
      toCwd: "D:/work/project-b",
      message: formatSwitchMessage("D:/work/project-a", "D:/work/project-b"),
      failureMessage: formatSwitchFailureMessage("D:/work/project-a"),
    });
  });

  test("reclaimable lock starts a replacement bridge", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "codex",
      requestedCwd: "D:/work/project",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "codex",
        command: "codex",
        cwd: "D:/work/project",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "companion_bound",
      },
      lockShouldAutoReclaim: true,
      endpoint: null,
      endpointIsReachable: false,
      companionIsAlive: false,
      sessionStartMode: "restore",
    });

    expect(decision).toEqual({
      kind: "start_bridge",
      message:
        "Detected reclaimable bridge lock for D:/work/project. Replacing it for D:/work/project...",
    });
  });

  test("same workspace with stopped visible worker requests auto-heal restart", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "codex",
      requestedCwd: "D:/work/project",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "codex",
        command: "codex",
        cwd: "D:/work/project",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "companion_bound",
      },
      lockShouldAutoReclaim: false,
      endpoint: {
        protocolVersion: 2,
        runtimeKind: "codex_runtime_host",
        instanceId: "bridge-1",
        kind: "codex",
        port: 8123,
        token: "token",
        cwd: "D:/work/project",
        command: "codex",
        startedAt: "2026-03-28T00:01:00.000Z",
        companionPid: 456,
        companionConnectedAt: "2026-03-28T00:02:00.000Z",
        companionStatus: "stopped",
        companionLastStateAt: "2026-03-28T00:03:00.000Z",
      },
      endpointIsReachable: true,
      companionIsAlive: true,
      sessionStartMode: "restore",
    });

    expect(decision).toEqual({
      kind: "restart_unhealthy",
      message: formatRestartUnhealthyMessage("D:/work/project"),
    });
  });

  test("same workspace start request replaces Claude when a fresh session is requested", () => {
    const decision = decideLaunchAction({
      requestedAdapter: "claude",
      requestedCwd: "D:/work/project",
      runningLock: {
        pid: 123,
        parentPid: 321,
        instanceId: "bridge-1",
        adapter: "claude",
        command: "claude",
        cwd: "D:/work/project",
        startedAt: "2026-03-28T00:00:00.000Z",
        lifecycle: "companion_bound",
      },
      lockShouldAutoReclaim: false,
      endpoint: {
        protocolVersion: 2,
        runtimeKind: "legacy_adapter",
        instanceId: "bridge-1",
        kind: "claude",
        port: 8123,
        token: "token",
        cwd: "D:/work/project",
        command: "claude",
        startedAt: "2026-03-28T00:01:00.000Z",
        companionPid: 456,
        companionConnectedAt: "2026-03-28T00:02:00.000Z",
        companionStatus: "idle",
      },
      endpointIsReachable: true,
      companionIsAlive: true,
      sessionStartMode: "new",
    });

    expect(decision).toEqual({
      kind: "start_bridge",
      message: "Starting a fresh claude session for D:/work/project...",
    });
  });
});
