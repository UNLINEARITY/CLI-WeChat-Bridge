import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { BridgeController } from "../../src/bridge/bridge-controller.ts";
import type {
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
} from "../../src/bridge/bridge-types.ts";
import {
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
  writeLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "../../src/companion/local-companion-link.ts";
import { LOCAL_CLIENT_PROTOCOL_VERSION } from "../../src/runtime/runtime-types.ts";
import { getWorkspaceChannelPaths } from "../../src/wechat/channel-config.ts";

const tempDirectories: string[] = [];

function makeTempCwd(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-controller-test-"));
  tempDirectories.push(directory);
  return directory;
}

function buildEndpoint(
  cwd: string,
  overrides: Partial<LocalCompanionEndpoint> = {},
): LocalCompanionEndpoint {
  return {
    protocolVersion: LOCAL_CLIENT_PROTOCOL_VERSION,
    runtimeKind: "legacy_adapter",
    instanceId: "legacy-1",
    kind: "claude",
    port: 8123,
    token: "token-1",
    cwd,
    command: "claude",
    startedAt: "2026-05-10T00:00:00.000Z",
    ...overrides,
  };
}

function buildAdapter(
  state: BridgeAdapterState,
): BridgeAdapter {
  return {
    setEventSink(_sink: (event: BridgeEvent) => void): void {},
    async start(): Promise<void> {},
    async sendInput(_text: string): Promise<void> {},
    async listResumeSessions(_limit?: number): Promise<BridgeResumeSessionCandidate[]> {
      return [];
    },
    async resumeSession(_sessionId: string): Promise<void> {},
    async interrupt(): Promise<boolean> {
      return false;
    },
    async reset(): Promise<void> {},
    async resolveApproval(_action: "confirm" | "deny"): Promise<boolean> {
      return false;
    },
    async resolveAllApprovals(_action: "confirm" | "deny"): Promise<number> {
      return 0;
    },
    async submitUserInput(_answers: Record<string, string[]>): Promise<boolean> {
      return false;
    },
    async dispose(): Promise<void> {},
    getState(): BridgeAdapterState {
      return state;
    },
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    clearLocalCompanionEndpoint(directory);
    try {
      fs.rmSync(getWorkspaceChannelPaths(directory).workspaceDir, {
        recursive: true,
        force: true,
      });
    } catch {
      // Best effort cleanup for test endpoints.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("BridgeController local client endpoint sync", () => {
  test("does not clear legacy adapter endpoints that are managed by the adapter itself", () => {
    const cwd = makeTempCwd();
    writeLocalCompanionEndpoint(buildEndpoint(cwd));

    const adapter = buildAdapter({
      kind: "claude",
      status: "starting",
      cwd,
      command: "claude",
    });

    new BridgeController(adapter, cwd).syncLocalClientEndpoint();

    expect(readLocalCompanionEndpoint(cwd)).toMatchObject({
      instanceId: "legacy-1",
      kind: "claude",
      port: 8123,
      token: "token-1",
    });
  });

  test("rewrites provider endpoints when the endpoint file was removed", () => {
    const cwd = makeTempCwd();
    const endpoint = buildEndpoint(cwd, {
      runtimeKind: "codex_runtime_host",
      instanceId: "codex-runtime-1",
      kind: "codex",
      port: 9123,
      token: "codex-token",
      command: "codex",
      serverPort: 9123,
      serverUrl: "ws://127.0.0.1:9123",
    });
    const adapter = {
      ...buildAdapter({
        kind: "codex",
        status: "idle",
        cwd,
        command: "codex",
      }),
      getLocalClientEndpoint: () => endpoint,
    };
    const controller = new BridgeController(adapter, cwd);

    controller.syncLocalClientEndpoint();
    clearLocalCompanionEndpoint(cwd, undefined, { adapter: "codex" });
    expect(readLocalCompanionEndpoint(cwd, { adapter: "codex" })).toBeNull();

    controller.syncLocalClientEndpoint();

    expect(readLocalCompanionEndpoint(cwd, { adapter: "codex" })).toMatchObject({
      instanceId: "codex-runtime-1",
      kind: "codex",
      runtimeKind: "codex_runtime_host",
      serverUrl: "ws://127.0.0.1:9123",
      companionStatus: "idle",
    });
  });
});
