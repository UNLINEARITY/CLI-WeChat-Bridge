import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  clearLocalCompanionEndpoint,
  clearLocalCompanionOccupancy,
  readLocalCompanionEndpoint,
  updateLocalCompanionHealth,
  updateLocalCompanionOccupancy,
  writeLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "../../src/companion/local-companion-link.ts";
import { getWorkspaceChannelPaths } from "../../src/wechat/channel-config.ts";
import { LOCAL_CLIENT_PROTOCOL_VERSION } from "../../src/runtime/runtime-types.ts";

const tempDirectories: string[] = [];
const endpointCwds: string[] = [];

function makeTempCwd(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-link-test-"));
  tempDirectories.push(directory);
  endpointCwds.push(directory);
  return directory;
}

function buildEndpoint(
  cwd: string,
  overrides: Partial<LocalCompanionEndpoint> = {},
): LocalCompanionEndpoint {
  return {
    protocolVersion: LOCAL_CLIENT_PROTOCOL_VERSION,
    runtimeKind: "legacy_adapter",
    instanceId: "bridge-1",
    kind: "codex",
    port: 8123,
    token: "token-1",
    cwd,
    command: "codex",
    startedAt: "2026-03-28T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  while (endpointCwds.length > 0) {
    const cwd = endpointCwds.pop();
    if (!cwd) {
      continue;
    }

    clearLocalCompanionEndpoint(cwd);
    try {
      fs.rmSync(getWorkspaceChannelPaths(cwd).workspaceDir, {
        recursive: true,
        force: true,
      });
    } catch {
      // Best effort cleanup for test endpoints.
    }
  }

  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("local companion endpoint occupancy", () => {
  test("stores separate adapter endpoints for the same workspace", () => {
    const cwd = makeTempCwd();

    writeLocalCompanionEndpoint(buildEndpoint(cwd, {
      instanceId: "codex-1",
      kind: "codex",
      command: "codex",
      port: 8123,
    }));
    writeLocalCompanionEndpoint(buildEndpoint(cwd, {
      instanceId: "claude-1",
      kind: "claude",
      command: "claude",
      port: 8124,
    }));

    expect(readLocalCompanionEndpoint(cwd, { adapter: "codex" })).toMatchObject({
      instanceId: "codex-1",
      kind: "codex",
      port: 8123,
    });
    expect(readLocalCompanionEndpoint(cwd, { adapter: "claude" })).toMatchObject({
      instanceId: "claude-1",
      kind: "claude",
      port: 8124,
    });
  });

  test("clears only the requested adapter endpoint when adapter is provided", () => {
    const cwd = makeTempCwd();

    writeLocalCompanionEndpoint(buildEndpoint(cwd, {
      instanceId: "codex-1",
      kind: "codex",
      command: "codex",
      port: 8123,
    }));
    writeLocalCompanionEndpoint(buildEndpoint(cwd, {
      instanceId: "opencode-1",
      kind: "opencode",
      command: "opencode",
      port: 8125,
    }));

    clearLocalCompanionEndpoint(cwd, undefined, { adapter: "codex" });

    expect(readLocalCompanionEndpoint(cwd, { adapter: "codex" })).toBeNull();
    expect(readLocalCompanionEndpoint(cwd, { adapter: "opencode" })).toMatchObject({
      instanceId: "opencode-1",
      kind: "opencode",
    });
  });

  test("readLocalCompanionEndpoint preserves visible client occupancy metadata", () => {
    const cwd = makeTempCwd();

    writeLocalCompanionEndpoint(
      buildEndpoint(cwd, {
        companionPid: 456,
        companionConnectedAt: "2026-03-28T00:01:00.000Z",
      }),
    );

    expect(readLocalCompanionEndpoint(cwd)).toMatchObject({
      instanceId: "bridge-1",
      cwd,
      companionPid: 456,
      companionConnectedAt: "2026-03-28T00:01:00.000Z",
    });
  });

  test("clearLocalCompanionOccupancy removes only visible client and health metadata", () => {
    const cwd = makeTempCwd();

    writeLocalCompanionEndpoint(
      buildEndpoint(cwd, {
        companionPid: 789,
        companionConnectedAt: "2026-03-28T00:03:00.000Z",
        companionStatus: "stopped",
        companionLastStateAt: "2026-03-28T00:04:00.000Z",
        companionWorkerPid: 4321,
      }),
    );

    clearLocalCompanionOccupancy(cwd);

    const endpoint = readLocalCompanionEndpoint(cwd);
    expect(endpoint).toMatchObject({
      instanceId: "bridge-1",
      cwd,
      port: 8123,
      token: "token-1",
    });
    expect(endpoint?.companionPid).toBeUndefined();
    expect(endpoint?.companionConnectedAt).toBeUndefined();
    expect(endpoint?.companionStatus).toBeUndefined();
    expect(endpoint?.companionLastStateAt).toBeUndefined();
    expect(endpoint?.companionWorkerPid).toBeUndefined();
  });

  test("updateLocalCompanionOccupancy stores visible client metadata", () => {
    const cwd = makeTempCwd();
    writeLocalCompanionEndpoint(buildEndpoint(cwd));

    updateLocalCompanionOccupancy(cwd, {
      companionPid: 1001,
      companionConnectedAt: "2026-03-28T00:05:00.000Z",
    });

    expect(readLocalCompanionEndpoint(cwd)).toMatchObject({
      instanceId: "bridge-1",
      companionPid: 1001,
      companionConnectedAt: "2026-03-28T00:05:00.000Z",
    });
  });

  test("updateLocalCompanionHealth stores the latest visible worker status", () => {
    const cwd = makeTempCwd();
    writeLocalCompanionEndpoint(buildEndpoint(cwd));

    updateLocalCompanionHealth(cwd, {
      companionStatus: "stopped",
      companionLastStateAt: "2026-03-28T00:07:00.000Z",
      companionWorkerPid: 4321,
    });

    expect(readLocalCompanionEndpoint(cwd)).toMatchObject({
      instanceId: "bridge-1",
      companionStatus: "stopped",
      companionLastStateAt: "2026-03-28T00:07:00.000Z",
      companionWorkerPid: 4321,
    });
  });
});
