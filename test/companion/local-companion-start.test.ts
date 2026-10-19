// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  attachDaemonSlot,
  ensureCompanionStartWechatCredentials,
  isSameWorkspaceCwd,
  normalizeComparablePath,
  parseCliArgs,
  runVisibleClient,
  buildEphemeralDaemonArgs,
  claimDaemonSlot,
  connectToDaemon,
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
    expect(options.sessionStartMode).toBe("new");
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
    expect(options.sessionStartMode).toBe("new");
    expect(options.cliArgs).toEqual(["--model", "openai/gpt-5.6-sol"]);
  });

  test("parseCliArgs allows Pi to explicitly restore the previous session", () => {
    const options = parseCliArgs([
      "--adapter",
      "pi",
      "--session-start-mode",
      "restore",
    ]);

    expect(options.sessionStartMode).toBe("restore");
    expect(options.cliArgs).toEqual([]);
  });

  test("parseCliArgs keeps --doctor out of native CLI passthrough", () => {
    const options = parseCliArgs(["--adapter", "pi", "--doctor"]);

    expect(options.adapter).toBe("pi");
    expect(options.cliArgs).toEqual([]);
  });

  test("parseCliArgs selects WeCom without forwarding the channel flag", () => {
    const options = parseCliArgs([
      "--adapter",
      "codex",
      "--channel",
      "wecom",
      "--yolo",
    ]);

    expect(options.channelId).toBe("wecom");
    expect(options.cliArgs).toEqual(["--yolo"]);
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
        sessionStartMode: "restore",
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

  const liveEndpoint = (overrides: Partial<DaemonEndpoint> = {}): DaemonEndpoint => ({
    protocolVersion: 1,
    pid: 123,
    port: 9123,
    token: "token",
    cwd: path.resolve("./tmp/project"),
    startedAt: "2026-05-22T00:00:00.000Z",
    ...overrides,
  });
  const launchOptions = (overrides: Partial<Parameters<typeof connectToDaemon>[0]> = {}) => ({
    adapter: "opencode" as const,
    cwd: path.resolve("./tmp/project"),
    timeoutMs: 15000,
    sessionStartMode: "new" as const,
    cliArgs: [],
    ...overrides,
  });

  test("connectToDaemon joins a live daemon in any directory without starting another", async () => {
    let started = 0;
    const endpoint = liveEndpoint({ cwd: "D:/work/project-a" });

    const connected = await connectToDaemon(launchOptions({ cwd: "D:/work/project-b" }), {
      readEndpoint: () => endpoint,
      isEndpointAlive: async () => true,
      startDaemon: () => {
        started += 1;
      },
    });

    expect(connected).toBe(endpoint);
    expect(started).toBe(0);
  });

  test("connectToDaemon starts an ephemeral daemon when none is running and waits for it", async () => {
    const endpoint = liveEndpoint();
    let current: DaemonEndpoint | null = null;
    const startedFor: string[] = [];

    const connected = await connectToDaemon(launchOptions(), {
      readEndpoint: () => current,
      isEndpointAlive: async () => true,
      startDaemon: (options) => {
        startedFor.push(options.cwd);
        current = endpoint;
      },
      sleep: async () => undefined,
    });

    expect(startedFor).toEqual([path.resolve("./tmp/project")]);
    expect(connected).toBe(endpoint);
  });

  test("connectToDaemon clears a stale endpoint before starting a daemon", async () => {
    const stale = liveEndpoint({ pid: 999 });
    const fresh = liveEndpoint({ pid: 456 });
    const cleared: number[] = [];
    let current: DaemonEndpoint | null = stale;

    const connected = await connectToDaemon(launchOptions(), {
      readEndpoint: () => current,
      isEndpointAlive: async (endpoint) => endpoint.pid !== 999,
      clearEndpoint: (pid) => {
        cleared.push(pid ?? 0);
        current = null;
      },
      startDaemon: () => {
        current = fresh;
      },
      sleep: async () => undefined,
    });

    expect(cleared).toEqual([999]);
    expect(connected).toBe(fresh);
  });

  test("connectToDaemon rejects a live daemon owned by another channel", async () => {
    await expect(
      connectToDaemon(launchOptions({ channelId: "wecom" }), {
        readEndpoint: () => liveEndpoint({ channelId: "wechat" }),
        isEndpointAlive: async () => true,
      }),
    ).rejects.toThrow("Stop it before starting the wecom channel");
  });

  test("claimDaemonSlot asks for a window-bound slot without opening a window", async () => {
    const requests: DaemonRequest[] = [];
    const timeouts: number[] = [];

    const claim = await claimDaemonSlot(
      launchOptions({ profile: "work", cliArgs: ["--mode", "build"] }),
      liveEndpoint(),
      {
        sendRequest: async (_endpoint, request, options) => {
          requests.push(request);
          timeouts.push(options?.timeoutMs ?? 0);
          return { ok: true, result: { created: true, activated: true } };
        },
      },
    );

    expect(claim).toEqual({ created: true, activated: true });
    expect(requests).toEqual([
      {
        command: "ensure_slot",
        adapter: "opencode",
        cwd: path.resolve("./tmp/project"),
        profile: "work",
        cliArgs: ["--mode", "build"],
        openVisible: false,
        sessionStartMode: "new",
        boundToWindow: true,
      },
    ]);
    expect(timeouts).toEqual([45_000]);
  });

  test("claimDaemonSlot reports a daemon that cannot prepare the slot", async () => {
    await expect(
      claimDaemonSlot(launchOptions(), liveEndpoint(), {
        sendRequest: async () => ({ ok: false, error: "Timed out waiting for daemon response." }),
      }),
    ).rejects.toThrow("could not prepare opencode");
  });

  test("attachDaemonSlot asks for a windowless codex slot on the requested thread", async () => {
    const requests: DaemonRequest[] = [];

    const claim = await attachDaemonSlot(
      launchOptions({ adapter: "codex", codexThreadId: "thread-7", attachCurrentSession: true }),
      liveEndpoint(),
      {
        sendRequest: async (_endpoint, request) => {
          requests.push(request);
          return { ok: true, result: { created: true, activated: true, sharedThreadId: "thread-7" } };
        },
      },
    );

    expect(claim.sharedThreadId).toBe("thread-7");
    expect(requests).toEqual([
      {
        command: "ensure_slot",
        adapter: "codex",
        cwd: path.resolve("./tmp/project"),
        profile: undefined,
        openVisible: false,
        sessionStartMode: "new",
        codexAttach: { threadId: "thread-7" },
      },
    ]);
  });

  test("buildEphemeralDaemonArgs starts the daemon in launcher mode for the channel", () => {
    expect(buildEphemeralDaemonArgs("/pkg/dist/daemon/wechat-daemon.js", {
      cwd: "/work/app",
      channelId: "telegram",
    })).toEqual([
      "--no-warnings",
      "/pkg/dist/daemon/wechat-daemon.js",
      "--ephemeral",
      "--cwd",
      "/work/app",
      "--channel",
      "telegram",
    ]);
    expect(buildEphemeralDaemonArgs("/repo/src/daemon/wechat-daemon.ts", { cwd: "/work/app" }))
      .toContain("--experimental-strip-types");
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

  test("normalizeComparablePath is stable for the same logical cwd", () => {
    const first = normalizeComparablePath(".");
    const second = normalizeComparablePath(process.cwd());
    expect(first).toBe(second);
  });

  test("isSameWorkspaceCwd matches equivalent directory paths", () => {
    expect(isSameWorkspaceCwd(".", process.cwd())).toBe(true);
  });

});
