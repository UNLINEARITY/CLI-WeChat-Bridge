import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ChildProcess, type spawn } from "node:child_process";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildRemoteCodexClientArgs,
  buildRemoteCodexClientEnv,
  CodexVisibleClientSupervisor,
  parseCliArgs,
} from "../../src/companion/codex-remote-client.ts";
import { requestCodexVisibleThreadSwitch } from "../../src/companion/codex-visible-client-link.ts";
import {
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
  writeLocalCompanionEndpoint,
} from "../../src/companion/local-companion-link.ts";
import {
  CODEX_REMOTE_AUTH_TOKEN_ENV,
  LOCAL_CLIENT_PROTOCOL_VERSION,
  type LocalClientEndpoint,
} from "../../src/runtime/runtime-types.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }
    clearLocalCompanionEndpoint(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Codex visible client test state.");
}

function buildEndpoint(
  overrides: Partial<LocalClientEndpoint> = {},
): LocalClientEndpoint {
  return {
    protocolVersion: LOCAL_CLIENT_PROTOCOL_VERSION,
    runtimeKind: "codex_runtime_host",
    instanceId: "bridge-123",
    kind: "codex",
    port: 8123,
    token: "super-secret-token",
    renderMode: "headless",
    bridgeOwnerPid: 9001,
    serverPort: 8123,
    serverUrl: "ws://127.0.0.1:8123",
    remoteAuthTokenEnv: CODEX_REMOTE_AUTH_TOKEN_ENV,
    cwd: path.resolve("./tmp/project"),
    command: "codex",
    profile: "wechat",
    sharedThreadId: "thread_123",
    startedAt: "2026-04-15T08:00:00.000Z",
    ...overrides,
  };
}

describe("codex remote client helpers", () => {
  test("parseCliArgs forwards unknown arguments to codex", () => {
    const options = parseCliArgs([
      "--cwd",
      "./tmp/project",
      "--yolo",
      "--model",
      "gpt-5.2",
    ]);

    expect(options.cwd).toBe(path.resolve("./tmp/project"));
    expect(options.cliArgs).toEqual(["--yolo", "--model", "gpt-5.2"]);
  });

  test("buildRemoteCodexClientArgs targets the bridge-owned app-server", () => {
    expect(buildRemoteCodexClientArgs(buildEndpoint())).toEqual([
      "resume",
      "thread_123",
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
      "--remote-auth-token-env",
      CODEX_REMOTE_AUTH_TOKEN_ENV,
    ]);
  });

  test("buildRemoteCodexClientArgs appends forwarded codex args after bridge args", () => {
    expect(
      buildRemoteCodexClientArgs(buildEndpoint(), {
        extraCliArgs: ["--yolo", "--model", "gpt-5.2"],
      }),
    ).toEqual([
      "resume",
      "thread_123",
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
      "--remote-auth-token-env",
      CODEX_REMOTE_AUTH_TOKEN_ENV,
      "--yolo",
      "--model",
      "gpt-5.2",
    ]);
  });

  test("buildRemoteCodexClientArgs can replace the visible thread explicitly", () => {
    expect(
      buildRemoteCodexClientArgs(buildEndpoint(), {
        resumeThreadId: "thread_target",
      }),
    ).toEqual([
      "resume",
      "thread_target",
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
      "--remote-auth-token-env",
      CODEX_REMOTE_AUTH_TOKEN_ENV,
    ]);
  });

  test("buildRemoteCodexClientArgs rejects bridge-owned remote options", () => {
    expect(() =>
      buildRemoteCodexClientArgs(buildEndpoint(), {
        extraCliArgs: ["--remote", "ws://127.0.0.1:9999"],
      }),
    ).toThrow(/--remote/);
  });

  test("buildRemoteCodexClientEnv injects the bridge token into the configured env var", () => {
    const endpoint = buildEndpoint({
      remoteAuthTokenEnv: "CUSTOM_CODEX_TOKEN",
    });
    const env = buildRemoteCodexClientEnv(endpoint, {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp/home");
    expect(env.CUSTOM_CODEX_TOKEN).toBe("super-secret-token");
  });

  test("supervises a visible Codex child and replaces it through the authenticated control link", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-codex-supervisor-"));
    tempDirectories.push(cwd);
    const endpoint = buildEndpoint({ cwd });
    writeLocalCompanionEndpoint(endpoint);

    const children = new Map<number, ChildProcess & EventEmitter>();
    const spawnCalls: string[][] = [];
    let nextPid = 10_000;
    const spawnProcess = ((
      _file: string,
      args: readonly string[],
    ): ChildProcess => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const pid = nextPid;
      nextPid += 1;
      Object.defineProperty(child, "pid", { value: pid });
      child.kill = (() => {
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      }) as ChildProcess["kill"];
      children.set(pid, child);
      spawnCalls.push([...args]);
      return child;
    }) as typeof spawn;
    const stopProcessTree = (pid: number) => {
      const child = children.get(pid);
      queueMicrotask(() => child?.emit("exit", 0, null));
    };
    const supervisor = new CodexVisibleClientSupervisor(
      endpoint,
      {},
      {
        spawnProcess,
        stopProcessTree,
        switchSettleMs: 5,
      },
    );

    const runPromise = supervisor.run();
    await waitFor(() => Boolean(readLocalCompanionEndpoint(cwd)?.codexControlPort));

    await requestCodexVisibleThreadSwitch({
      cwd,
      instanceId: endpoint.instanceId,
      threadId: "thread_target",
    });

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.join(" ")).toContain("resume thread_123");
    expect(spawnCalls[1]?.join(" ")).toContain("resume thread_target");
    expect(readLocalCompanionEndpoint(cwd)?.codexVisibleThreadId).toBe("thread_target");

    const activeChild = children.get(10_001);
    activeChild?.emit("exit", 0, null);
    expect(await runPromise).toBe(0);
    expect(readLocalCompanionEndpoint(cwd)?.codexControlPort).toBeUndefined();
  });
});
