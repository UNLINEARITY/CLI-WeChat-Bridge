// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import { t } from "../i18n/index.ts";
import type { BridgeSessionStartMode } from "../bridge/bridge-types.ts";
import { BRIDGE_LOG_FILE } from "../wechat/channel-config.ts";
import type { BridgeChannelId } from "../core/channel-types.ts";
import { getBridgeChannelDisplayName, isBridgeChannelId } from "../core/channel-types.ts";
import type { DaemonAdapterKind, DaemonStatus } from "./daemon-link.ts";
import { DAEMON_ADAPTERS, isDaemonAdapterKind } from "./daemon-shared.ts";

export type DaemonCliOptions = {
  cwd: string;
  profile?: string;
  initialAdapter?: DaemonAdapterKind;
  openVisible: boolean;
  channelId?: BridgeChannelId;
};

export function parseDaemonCliArgs(argv: string[]): DaemonCliOptions {
  let cwd = process.cwd();
  let profile: string | undefined;
  let initialAdapter: DaemonAdapterKind | undefined;
  let openVisible = true;
  let channelId: BridgeChannelId = "wechat";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      const channelDisplayName = getBridgeChannelDisplayName(channelId);
      process.stdout.write(
        [
          `Usage: ${channelId}-daemon [--cwd <path>] [--adapter <codex|claude|opencode|pi>] [--profile <name-or-path>] [--no-open]`,
          "",
          `Keeps one ${channelDisplayName} connection alive and switches between Codex, Claude Code, OpenCode, and Pi.`,
          `Send /codex, /claude, /opencode, or /pi in ${channelDisplayName} to switch the active terminal.`,
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--channel") {
      if (!isBridgeChannelId(next)) {
        throw new Error(`Invalid channel: ${next ?? "(missing)"}`);
      }
      channelId = next;
      i += 1;
      continue;
    }

    if (arg === "--adapter") {
      if (!isDaemonAdapterKind(next)) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      initialAdapter = next;
      i += 1;
      continue;
    }

    if (arg === "--profile") {
      if (!next) {
        throw new Error("--profile requires a value");
      }
      profile = next;
      i += 1;
      continue;
    }

    if (arg === "--no-open") {
      openVisible = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    cwd,
    profile,
    initialAdapter,
    openVisible,
    ...(channelId === "wechat" ? {} : { channelId }),
  };
}

export function parseDaemonSwitchCommand(text: string): DaemonAdapterKind | null {
  const normalized = text.trim().toLowerCase();
  switch (normalized) {
    case "/codex":
      return "codex";
    case "/claude":
      return "claude";
    case "/opencode":
      return "opencode";
    case "/pi":
      return "pi";
    default:
      return null;
  }
}

export type DaemonSwitchDirective = {
  adapter: DaemonAdapterKind;
  remainder: string;
};

export function parseDaemonSwitchDirective(text: string): DaemonSwitchDirective | null {
  const match = text
    .trim()
    .match(/^\/(codex|claude|opencode|pi)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }
  return {
    adapter: match[1]!.toLowerCase() as DaemonAdapterKind,
    remainder: match[2]?.trim() ?? "",
  };
}

export function defaultDaemonSessionStartMode(
  _adapter: DaemonAdapterKind,
): BridgeSessionStartMode {
  // Codex 0.155+ persists app-server threads lazily, so resuming a freshly
  // prepared (not yet persisted) thread crashes the visible TUI bootstrap
  // with "no rollout found". Every adapter therefore opens a fresh session
  // by default; explicit --session-start-mode restore and WeChat /resume
  // remain available for deliberate restores of persisted threads.
  return "new";
}

export function resolveDaemonSessionStartMode(params: {
  adapter: DaemonAdapterKind;
  explicitSessionStartMode?: BridgeSessionStartMode;
  slotCreated: boolean;
  visibleConnected: boolean;
  sharedSessionId?: string;
  reuseExistingVisible?: boolean;
}): BridgeSessionStartMode {
  // An explicit --session-start-mode wins over visible-client reuse: the user
  // asked for a fresh (or restored) session on purpose, so silently degrading
  // "new" back to "restore" because a window happens to be connected would
  // ignore the request.
  if (params.explicitSessionStartMode) {
    return params.explicitSessionStartMode;
  }
  if (params.reuseExistingVisible && params.visibleConnected) {
    return "restore";
  }
  if (params.slotCreated) {
    return "new";
  }
  if (!params.visibleConnected && !params.sharedSessionId) {
    return "new";
  }
  return "restore";
}

export function formatNoActiveAdapterMessage(): string {
  return t("daemon.noActiveAdapter");
}

export function formatDaemonSwitchResultDetail(result: {
  created: boolean;
  openedVisible: boolean;
  visibleConnected: boolean;
  visibleReady?: boolean;
  activated?: boolean;
  previousActiveAdapter?: DaemonAdapterKind;
}): string {
  const previous = result.activated === false
    ? result.previousActiveAdapter
      ? t("daemon.switch.previous", { adapter: result.previousActiveAdapter })
      : t("daemon.switch.none")
    : "";
  if (result.activated === false && result.visibleConnected && result.visibleReady === false) {
    return t("daemon.switch.threadNotReady", { previous, log: BRIDGE_LOG_FILE });
  }
  if (result.openedVisible && (result.activated === false || !result.visibleConnected)) {
    return t(result.created ? "daemon.switch.newNotConnected" : "daemon.switch.existingNotConnected", { previous, log: BRIDGE_LOG_FILE });
  }
  if (result.activated === false) return t("daemon.switch.notConnected", { previous, log: BRIDGE_LOG_FILE });
  if (result.openedVisible && result.visibleConnected) return t(result.created ? "daemon.switchResult.new" : "daemon.switch.opened");
  if (result.visibleConnected) return t("daemon.switchResult.reused");
  return t(result.created ? "daemon.switch.slotStarted" : "daemon.switch.slotReused");
}

export function formatDaemonStatus(status: DaemonStatus): string {
  const lines = [
    t("status.daemon", { channel: status.channelId ?? "wechat" }),
    `${t("status.label.cwd")}: ${status.cwd}`,
    `${t("status.label.active")}: ${status.activeAdapter ?? t("status.none")}`,
    `${t("status.label.started_at")}: ${status.startedAt}`,
  ];

  for (const adapter of DAEMON_ADAPTERS) {
    const slot = status.slots.find((entry) => entry.adapter === adapter);
    if (!slot) {
      lines.push(`${adapter}: ${t("status.notStarted")}`);
      continue;
    }
    const flags = [
      slot.pendingApproval ? t("status.pendingApproval") : "",
      slot.pendingUserInput ? t("status.pendingInput") : "",
      slot.companionPid ? `companion_pid=${slot.companionPid}` : "",
    ].filter(Boolean);
    lines.push(`${adapter}: ${slot.status}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  }

  return lines.join("\n");
}
