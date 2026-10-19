// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";

import { BRIDGE_LOCK_FILE } from "../wechat/channel-config.ts";
import type {
  BridgeAdapterKind,
  LegacyBridgeAdapterKind,
  BridgeLifecycleMode,
  BridgeState,
} from "./bridge-types.ts";
import type { BridgeChannelId } from "../core/channel-types.ts";

export type BridgeLockPayload = {
  pid: number;
  parentPid: number;
  instanceId: string;
  adapter: LegacyBridgeAdapterKind;
  command: string;
  cwd: string;
  startedAt: string;
  lifecycle: BridgeLifecycleMode;
  legacyLifecycleFallback?: true;
  channelId?: BridgeChannelId;
};

export function resolveRestorableSharedSessionId(
  persisted: Partial<BridgeState> | null | undefined,
  options: {
    adapter: BridgeAdapterKind;
    cwd: string;
  },
): string | undefined {
  if (
    !persisted ||
    persisted.cwd !== options.cwd ||
    persisted.adapter !== options.adapter
  ) {
    return undefined;
  }

  return persisted.sharedSessionId ?? persisted.sharedThreadId;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function normalizeBridgeLockPayload(value: unknown): BridgeLockPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    typeof record.instanceId !== "string" ||
    typeof record.adapter !== "string" ||
    typeof record.command !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return null;
  }

  const adapter =
    record.adapter === "codex" ||
    record.adapter === "claude" ||
    record.adapter === "opencode" ||
    record.adapter === "pi" ||
    record.adapter === "shell"
      ? record.adapter
      : null;
  if (!adapter) {
    return null;
  }

  const hasExplicitLifecycle =
    record.lifecycle === "persistent" || record.lifecycle === "companion_bound";

  return {
    pid: record.pid,
    parentPid: typeof record.parentPid === "number" ? record.parentPid : 0,
    instanceId: record.instanceId,
    adapter,
    command: record.command,
    cwd: record.cwd,
    startedAt: record.startedAt,
    lifecycle: record.lifecycle === "companion_bound" ? "companion_bound" : "persistent",
    legacyLifecycleFallback: hasExplicitLifecycle ? undefined : true,
    ...(record.channelId === "wechat" ||
      record.channelId === "wecom" ||
      record.channelId === "telegram"
      ? { channelId: record.channelId }
      : {}),
  };
}

export function readBridgeLockFile(): BridgeLockPayload | null {
  try {
    if (!fs.existsSync(BRIDGE_LOCK_FILE)) {
      return null;
    }
    return normalizeBridgeLockPayload(JSON.parse(fs.readFileSync(BRIDGE_LOCK_FILE, "utf-8")));
  } catch {
    return null;
  }
}

export function shouldAutoReclaimBridgeLock(
  lock: BridgeLockPayload,
  isProcessAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  if (
    lock.lifecycle === "companion_bound" ||
    (lock.legacyLifecycleFallback === true && lock.adapter === "codex")
  ) {
    return lock.parentPid > 1 && !isProcessAlive(lock.parentPid);
  }

  // For persistent lifecycle (e.g. opencode), reclaim the lock if the
  // lock-holding process is no longer alive.  This prevents stale locks
  // from permanently blocking subsequent bridge starts when the process
  // was force-killed (SIGKILL, Task Manager, OOM, etc.).
  return !isProcessAlive(lock.pid);
}

