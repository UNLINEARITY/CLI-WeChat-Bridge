// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import path from "node:path";

import { resolveRestorableSharedSessionId } from "../bridge/bridge-state.ts";
import type { BridgeAdapterState, BridgeState } from "../bridge/bridge-types.ts";
import { writeJsonFileAtomic } from "../utils/atomic-file.ts";
import { getWorkspaceChannelPaths } from "../wechat/channel-config.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";

/** The session a slot last followed, used to restore it on request. */
export type SlotSessionRecord = {
  sharedSessionId?: string;
  resumeConversationId?: string;
  transcriptPath?: string;
};

export type SlotSessionStore = {
  read(cwd: string, adapter: DaemonAdapterKind): SlotSessionRecord | null;
  write(cwd: string, adapter: DaemonAdapterKind, record: SlotSessionRecord): void;
};

/** The session fields of an adapter state worth persisting. */
export function toSlotSessionRecord(state: BridgeAdapterState): SlotSessionRecord {
  const sharedSessionId = state.sharedSessionId ?? state.sharedThreadId;
  return {
    ...(sharedSessionId ? { sharedSessionId } : {}),
    ...(state.resumeConversationId ? { resumeConversationId: state.resumeConversationId } : {}),
    ...(state.transcriptPath ? { transcriptPath: state.transcriptPath } : {}),
  };
}

export function sameSlotSession(left: SlotSessionRecord | null, right: SlotSessionRecord): boolean {
  return Boolean(left) &&
    left!.sharedSessionId === right.sharedSessionId &&
    left!.resumeConversationId === right.resumeConversationId &&
    left!.transcriptPath === right.transcriptPath;
}

function slotSessionFile(cwd: string, adapter: DaemonAdapterKind): string {
  return path.join(getWorkspaceChannelPaths(cwd).workspaceDir, `slot-session-${adapter}.json`);
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Session records stored next to the workspace's other state. Before a slot
 * has saved anything, the standalone bridge's `bridge-state.json` from older
 * versions is read once as a fallback, so restores survive the upgrade.
 */
export const fileSlotSessionStore: SlotSessionStore = {
  read(cwd, adapter) {
    const record = readJson(slotSessionFile(cwd, adapter));
    if (record) {
      return {
        sharedSessionId: optionalString(record.sharedSessionId),
        resumeConversationId: optionalString(record.resumeConversationId),
        transcriptPath: optionalString(record.transcriptPath),
      };
    }
    const legacy = readJson(getWorkspaceChannelPaths(cwd).stateFile) as Partial<BridgeState> | null;
    const sharedSessionId = resolveRestorableSharedSessionId(legacy, { adapter, cwd });
    if (!legacy || !sharedSessionId) {
      return null;
    }
    return {
      sharedSessionId,
      resumeConversationId: optionalString(legacy.resumeConversationId),
      transcriptPath: optionalString(legacy.transcriptPath),
    };
  },
  write(cwd, adapter, record) {
    const filePath = slotSessionFile(cwd, adapter);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeJsonFileAtomic(filePath, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
  },
};
