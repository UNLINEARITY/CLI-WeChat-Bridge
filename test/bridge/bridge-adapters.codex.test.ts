// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "../../src/i18n/index.ts";

import {
  CodexPtyAdapter,
  isCodexVersionInCompatibilityRange,
  parseCodexCliVersion,
  resolveAdoptableAppServer,
  shouldSuppressCodexTransportFatalError,
  shouldTreatCodexNativeExitAsExpected,
} from "../../src/bridge/bridge-adapters.codex.ts";

beforeEach(() => setLocale("en"));

describe("app-server adoption after a daemon restart", () => {
  const endpoint = {
    protocolVersion: 2,
    runtimeKind: "codex_runtime_host" as const,
    instanceId: "45240-mvsygmx3",
    kind: "codex" as const,
    slotInstance: 2,
    port: 52678,
    token: "17305035fdea7610847a340780475be3a18c6ba1f123ecbb",
    renderMode: "headless" as const,
    bridgeOwnerPid: 45240,
    serverPort: 52678,
    serverUrl: "ws://127.0.0.1:52715",
    remoteAuthTokenEnv: "WECHAT_BRIDGE_CODEX_REMOTE_AUTH_TOKEN",
    cwd: "D:\\ts\\passt",
    command: "codex",
    companionPid: 16116,
    companionConnectedAt: "2026-10-29T02:59:59.317Z",
    companionStatus: "idle" as const,
    companionLastStateAt: "2026-10-29T03:01:35.820Z",
    companionWorkerPid: 69340,
    codexControlPort: 52737,
    codexControlToken: "64da5cce0206c67f1f3ba4ab67c31ca1becb9ad339d409f7",
    startedAt: "2026-10-29T02:59:59.071Z",
  };

  test("adopts the persisted app-server while the companion is alive", () => {
    expect(resolveAdoptableAppServer(endpoint, () => true)).toEqual({
      port: 52678,
      token: "17305035fdea7610847a340780475be3a18c6ba1f123ecbb",
    });
  });

  test("refuses adoption when the companion (window) is dead", () => {
    expect(resolveAdoptableAppServer(endpoint, () => false)).toBeNull();
  });

  test("refuses adoption when the endpoint lacks the app-server or companion", () => {
    expect(resolveAdoptableAppServer(null, () => true)).toBeNull();
    expect(
      resolveAdoptableAppServer({ ...endpoint, companionPid: undefined }, () => true),
    ).toBeNull();
    expect(
      resolveAdoptableAppServer({ ...endpoint, port: undefined }, () => true),
    ).toBeNull();
    expect(
      resolveAdoptableAppServer({ ...endpoint, token: undefined }, () => true),
    ).toBeNull();
  });
});

describe("Codex version compatibility", () => {
  test("parses the installed Codex CLI version", () => {
    expect(parseCodexCliVersion("codex-cli 0.151.0\n")).toBe("0.151.0");
  });

  test("accepts the validated Codex 0.149 through 0.161 range", () => {
    expect(isCodexVersionInCompatibilityRange("0.149.1")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.151.0")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.155.0")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.156.0")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.157.1")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.158.0")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.161.0")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.148.0")).toBe(false);
    expect(isCodexVersionInCompatibilityRange("0.162.0")).toBe(false);
    expect(isCodexVersionInCompatibilityRange("1.0.0")).toBe(false);
  });
});

describe("codex exit handling", () => {
  test("treats a clean native panel exit as expected", () => {
    expect(
      shouldTreatCodexNativeExitAsExpected({
        renderMode: "panel",
        shuttingDown: false,
        exitCode: 0,
      }),
    ).toBe(true);
  });

  test("keeps embedded codex exit code 0 as unexpected", () => {
    expect(
      shouldTreatCodexNativeExitAsExpected({
        renderMode: "embedded",
        shuttingDown: false,
        exitCode: 0,
      }),
    ).toBe(false);
  });

  test("suppresses transport fatal errors while a clean panel exit is in progress", () => {
    expect(
      shouldSuppressCodexTransportFatalError({
        transportShuttingDown: false,
        shuttingDown: false,
        cleanPanelExitInProgress: true,
      }),
    ).toBe(true);
  });

  test("keeps the fatal tail of the app-server log", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    adapter.appServerLog = `${"startup ".repeat(80)}\nactual fatal detail`;

    const details = adapter.describeAppServerLog();

    expect(details).toContain("actual fatal detail");
    expect(details.length).toBeLessThan(560);
  });
});

describe("Codex visible client preparation", () => {
  test("creates and stores a shared thread before the visible client starts", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return method === "thread/start" ? { thread: { id: "thread_prepared" } } : {};
    };

    await expect(adapter.prepareVisibleClientSession()).resolves.toBe(true);
    expect(adapter.getState()).toMatchObject({
      sharedSessionId: "thread_prepared",
      sharedThreadId: "thread_prepared",
    });
    expect(requests).toEqual([
      {
        method: "thread/start",
        params: {
          cwd: process.cwd(),
          serviceName: "wechat-bridge",
        },
      },
    ]);

    await expect(adapter.prepareVisibleClientSession()).resolves.toBe(true);
    expect(requests).toHaveLength(1);
  });

  test("does not create a thread for native panel mode", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    adapter.sendRpcRequest = async () => {
      throw new Error("thread/start should not be called for panel mode");
    };

    await expect(adapter.prepareVisibleClientSession()).resolves.toBe(false);
  });
});
