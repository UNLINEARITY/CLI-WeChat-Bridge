import { describe, expect, test } from "bun:test";

import {
  evaluateBridgeRuntimeOwnership,
  normalizeBridgeLockPayload,
  resolveRestorableSharedSessionId,
  shouldAutoReclaimBridgeLock,
} from "../../src/bridge/bridge-state.ts";

describe("bridge-state lock helpers", () => {
  test("restores shared sessions only for the same adapter and workspace", () => {
    expect(
      resolveRestorableSharedSessionId(
        {
          adapter: "codex",
          cwd: "C:\\workspace",
          sharedSessionId: "thread-codex",
        },
        {
          adapter: "codex",
          cwd: "C:\\workspace",
        },
      ),
    ).toBe("thread-codex");

    expect(
      resolveRestorableSharedSessionId(
        {
          adapter: "opencode",
          cwd: "C:\\workspace",
          sharedSessionId: "ses_opencode",
        },
        {
          adapter: "codex",
          cwd: "C:\\workspace",
        },
      ),
    ).toBeUndefined();

    expect(
      resolveRestorableSharedSessionId(
        {
          adapter: "codex",
          cwd: "C:\\other",
          sharedSessionId: "thread-other",
        },
        {
          adapter: "codex",
          cwd: "C:\\workspace",
        },
      ),
    ).toBeUndefined();
  });

  test("normalizeBridgeLockPayload defaults old lock files to persistent lifecycle", () => {
    const payload = normalizeBridgeLockPayload({
      pid: 123,
      parentPid: 456,
      instanceId: "bridge-123",
      adapter: "codex",
      command: "codex",
      cwd: "C:\\workspace",
      startedAt: "2026-03-27T00:00:00.000Z",
    });

    expect(payload?.lifecycle).toBe("persistent");
    expect(payload?.legacyLifecycleFallback).toBe(true);
  });

  test("normalizeBridgeLockPayload accepts opencode locks", () => {
    const payload = normalizeBridgeLockPayload({
      pid: 123,
      parentPid: 456,
      instanceId: "bridge-123",
      adapter: "opencode",
      command: "opencode",
      cwd: "C:\\workspace",
      startedAt: "2026-03-27T00:00:00.000Z",
      lifecycle: "persistent",
    });

    expect(payload).toEqual({
      pid: 123,
      parentPid: 456,
      instanceId: "bridge-123",
      adapter: "opencode",
      command: "opencode",
      cwd: "C:\\workspace",
      startedAt: "2026-03-27T00:00:00.000Z",
      lifecycle: "persistent",
      legacyLifecycleFallback: undefined,
    });
  });

  test("shouldAutoReclaimBridgeLock reclaims companion-bound locks when the parent is gone", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "companion_bound",
        },
        (pid) => pid === 123,
      ),
    ).toBe(true);
  });

  test("shouldAutoReclaimBridgeLock reclaims legacy codex locks when the parent is gone", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "persistent",
          legacyLifecycleFallback: true,
        },
        (pid) => pid === 123,
      ),
    ).toBe(true);
  });

  test("shouldAutoReclaimBridgeLock keeps persistent locks even when the parent is gone", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "persistent",
        },
        (pid) => pid === 123,
      ),
    ).toBe(false);
  });

  test("shouldAutoReclaimBridgeLock keeps companion-bound locks while the parent is still alive", () => {
    expect(
      shouldAutoReclaimBridgeLock(
        {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-123",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "companion_bound",
        },
        (pid) => pid === 123 || pid === 456,
      ),
    ).toBe(false);
  });

  test("evaluateBridgeRuntimeOwnership yields to a newer workspace instance", () => {
    expect(
      evaluateBridgeRuntimeOwnership({
        currentInstanceId: "bridge-old",
        currentPid: 123,
        workspaceStateInstanceId: "bridge-new",
        lock: null,
      }),
    ).toEqual({
      ok: false,
      reason: "superseded",
      activeInstanceId: "bridge-new",
    });
  });

  test("evaluateBridgeRuntimeOwnership keeps the current live lock owner active", () => {
    expect(
      evaluateBridgeRuntimeOwnership({
        currentInstanceId: "bridge-current",
        currentPid: 123,
        workspaceStateInstanceId: "bridge-current",
        lock: {
          pid: 123,
          parentPid: 456,
          instanceId: "bridge-current",
          adapter: "opencode",
          command: "opencode",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "persistent",
        },
      }),
    ).toEqual({
      ok: true,
      rehydratedLock: false,
    });
  });

  test("evaluateBridgeRuntimeOwnership rehydrates a missing lock for the current instance", () => {
    expect(
      evaluateBridgeRuntimeOwnership({
        currentInstanceId: "bridge-current",
        currentPid: 123,
        workspaceStateInstanceId: "bridge-current",
        lock: null,
      }),
    ).toEqual({
      ok: true,
      rehydratedLock: true,
    });
  });

  test("evaluateBridgeRuntimeOwnership yields to a different live lock owner", () => {
    expect(
      evaluateBridgeRuntimeOwnership({
        currentInstanceId: "bridge-current",
        currentPid: 123,
        workspaceStateInstanceId: "bridge-current",
        lock: {
          pid: 789,
          parentPid: 456,
          instanceId: "bridge-other",
          adapter: "codex",
          command: "codex",
          cwd: "C:\\workspace",
          startedAt: "2026-03-27T00:00:00.000Z",
          lifecycle: "persistent",
        },
        isProcessAlive: (pid) => pid === 789,
      }),
    ).toEqual({
      ok: false,
      reason: "lock_conflict",
      activeInstanceId: "bridge-other",
      activePid: 789,
    });
  });
});
