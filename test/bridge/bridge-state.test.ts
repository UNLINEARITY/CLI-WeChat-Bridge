// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import {
  classifyLockHolderProcess,
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

  test("normalizeBridgeLockPayload keeps legacy shell locks readable for cleanup", () => {
    const payload = normalizeBridgeLockPayload({
      pid: 123,
      parentPid: 456,
      instanceId: "bridge-shell",
      adapter: "shell",
      command: "powershell.exe",
      cwd: "C:\\workspace",
      startedAt: "2026-03-27T00:00:00.000Z",
      lifecycle: "persistent",
    });

    expect(payload?.adapter).toBe("shell");
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

});
