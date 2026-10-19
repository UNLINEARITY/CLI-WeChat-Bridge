// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import {
  BRIDGE_LOG_FILE,
  appendBoundedLog,
  ensureChannelDataDir,
} from "../wechat/channel-config.ts";
import type { BridgeChannelId } from "../core/channel-types.ts";
import { normalizeBridgeChannelId } from "../core/channel-types.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";

export const DAEMON_ADAPTERS: DaemonAdapterKind[] = ["codex", "claude", "opencode", "pi"];

export function getCliChannelId(argv: string[] = process.argv.slice(2)): BridgeChannelId {
  const index = argv.indexOf("--channel");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return normalizeBridgeChannelId(value);
}

export function log(message: string): void {
  process.stderr.write(`[${getCliChannelId()}-daemon] ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`[${getCliChannelId()}-daemon] ERROR: ${message}\n`);
}

export function appendDaemonLog(message: string): void {
  ensureChannelDataDir();
  appendBoundedLog(
    BRIDGE_LOG_FILE,
    `[${new Date().toISOString()}] daemon: ${message}\n`,
  );
}

export function isDaemonAdapterKind(value: string | undefined): value is DaemonAdapterKind {
  return value === "codex" || value === "claude" || value === "opencode" || value === "pi";
}

export function isSameWorkspaceCwd(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
