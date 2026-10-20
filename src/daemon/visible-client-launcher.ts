// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { quoteWindowsCommandArg } from "../bridge/bridge-adapters.shared.ts";
import { killProcessTreeSync } from "../bridge/bridge-process-reaper.ts";
import type { BridgeSessionStartMode } from "../bridge/bridge-types.ts";
import type { BridgeChannelId } from "../core/channel-types.ts";
import {
  clearLocalCompanionOccupancy,
  readLocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";
import { isPidAlive, type DaemonAdapterKind } from "./daemon-link.ts";
import { sleep } from "./daemon-shared.ts";

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const RUNTIME_ENTRY_EXTENSION = path.extname(MODULE_FILE) === ".ts" ? ".ts" : ".js";
export const VISIBLE_CLIENT_CONNECT_TIMEOUT_MS = 15_000;
const VISIBLE_CLIENT_CONNECT_POLL_MS = 250;

export function buildVisibleClientLaunchArgs(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  /** Numbered window of the adapter in cwd; defaults to 1. */
  instance?: number;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs?: string[];
}): string[] {
  const entryPath =
    params.adapter === "codex"
      ? path.resolve(
          MODULE_DIR,
          "..",
          "companion",
          `codex-remote-client${RUNTIME_ENTRY_EXTENSION}`,
        )
      : path.resolve(
          MODULE_DIR,
          "..",
          "companion",
          `local-companion${RUNTIME_ENTRY_EXTENSION}`,
        );
  const args = ["--no-warnings"];
  if (path.extname(entryPath) === ".ts") {
    args.push("--experimental-strip-types");
  }
  args.push(entryPath);
  if (params.adapter !== "codex") {
    args.push("--adapter", params.adapter);
  }
  if (params.sessionStartMode && params.sessionStartMode !== "restore") {
    args.push("--session-start-mode", params.sessionStartMode);
  }
  if (params.instance && params.instance > 1) {
    args.push("--slot-instance", String(params.instance));
  }
  args.push("--cwd", params.cwd, ...(params.cliArgs ?? []));
  return args;
}

/** Terminal window title; names the workspace when the caller provides one. */
function visibleClientTitle(params: {
  adapter: DaemonAdapterKind;
  channelId?: BridgeChannelId;
  title?: string;
}): string {
  return params.title ?? `${params.channelId ?? "wechat"}-${params.adapter}`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildWindowsVisibleClientLaunchCommand(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  args: string[];
  channelId?: BridgeChannelId;
  title?: string;
}): string {
  return [
    "start",
    quoteWindowsCommandArg(visibleClientTitle(params)),
    "/D",
    quoteWindowsCommandArg(params.cwd),
    quoteWindowsCommandArg(process.execPath),
    ...params.args.map((arg) => quoteWindowsCommandArg(arg)),
  ].join(" ");
}

type LinuxTerminalEntry = { cmd: string; buildArgs: (title: string) => string[] };

const LINUX_TERMINALS: LinuxTerminalEntry[] = [
  { cmd: "gnome-terminal", buildArgs: (title) => ["--title", title, "--"] },
  { cmd: "konsole", buildArgs: (title) => ["-p", `tabtitle=${title}`, "-e"] },
  { cmd: "xfce4-terminal", buildArgs: (title) => ["--title", title, "-e"] },
  { cmd: "xterm", buildArgs: (title) => ["-title", title, "-e"] },
];

let cachedLinuxTerminal: LinuxTerminalEntry | null | undefined;

function detectLinuxTerminal(): LinuxTerminalEntry | null {
  if (cachedLinuxTerminal !== undefined) {
    return cachedLinuxTerminal;
  }
  for (const entry of LINUX_TERMINALS) {
    try {
      execFileSync("which", [entry.cmd], { stdio: "ignore" });
      cachedLinuxTerminal = entry;
      return entry;
    } catch {
      // not found, try next
    }
  }
  cachedLinuxTerminal = null;
  return null;
}

function shellQuotePosix(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export type VisibleClientLaunch = {
  command: string;
  args: string[];
  pid?: number;
};

export function formatLaunchPreview(launch: VisibleClientLaunch): string {
  return [launch.command, ...launch.args].join(" ");
}

export function openVisibleClient(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  instance?: number;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs?: string[];
  onError?: (error: Error) => void;
  channelId?: BridgeChannelId;
  /** Window title, e.g. `wechat-codex · my-app`. */
  title?: string;
}): VisibleClientLaunch {
  const args = buildVisibleClientLaunchArgs(params);
  // E2E harness override: host the visible client in a PTY owned by an
  // external launcher script instead of a terminal window, so automated
  // runs can type and read the TUI while every other step stays identical.
  const launcherOverride = process.env.CLI_BRIDGE_VISIBLE_LAUNCHER;
  if (launcherOverride) {
    const child = spawn(process.execPath, [launcherOverride, ...args], {
      cwd: params.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return {
      command: process.execPath,
      args: [launcherOverride, ...args],
      pid: child.pid,
    };
  }
  if (process.platform === "win32") {
    const command = process.env.ComSpec || "cmd.exe";
    const launchArgs = [
      "/d",
      "/c",
      buildWindowsVisibleClientLaunchCommand({
        adapter: params.adapter,
        cwd: params.cwd,
        args,
        channelId: params.channelId,
        title: params.title,
      }),
    ];
    const child = spawn(
      command,
      launchArgs,
      {
        cwd: params.cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
        windowsHide: false,
      },
    );
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return {
      command,
      args: launchArgs,
      pid: child.pid,
    };
  }

  const title = visibleClientTitle(params);
  const fullArgs = [process.execPath, ...args];

  if (process.platform === "darwin") {
    const cmdLine = fullArgs.map(shellQuotePosix).join(" ");
    const script = `tell application "Terminal"
activate
set clientTab to do script "cd ${shellQuotePosix(params.cwd)} && exec ${cmdLine}"
set custom title of clientTab to ${appleScriptString(title)}
end tell`;
    const child = spawn("osascript", ["-e", script], {
      cwd: params.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return {
      command: "osascript",
      args: ["-e", script],
      pid: child.pid,
    };
  }

  const terminal = detectLinuxTerminal();
  if (terminal) {
    const termArgs = [...terminal.buildArgs(title), ...fullArgs];
    const child = spawn(terminal.cmd, termArgs, {
      cwd: params.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return {
      command: terminal.cmd,
      args: termArgs,
      pid: child.pid,
    };
  }

  const child = spawn(process.execPath, args, {
    cwd: params.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    params.onError?.(error instanceof Error ? error : new Error(String(error)));
  });
  child.unref();
  return {
    command: process.execPath,
    args,
    pid: child.pid,
  };
}

export function isVisibleClientAlive(
  cwd: string,
  adapter: DaemonAdapterKind,
  instance = 1,
): boolean {
  const endpoint = readLocalCompanionEndpoint(cwd, { adapter, instance });
  if (!endpoint?.companionPid) {
    return false;
  }
  if (isPidAlive(endpoint.companionPid)) {
    return true;
  }

  clearLocalCompanionOccupancy(cwd, endpoint.instanceId, { adapter, instance });
  return false;
}

export function shouldRestartDeadCodexVisibleRuntime(params: {
  adapter: DaemonAdapterKind;
  slotCreated: boolean;
  hadVisibleClient: boolean;
  visibleConnected: boolean;
}): boolean {
  return (
    params.adapter === "codex" &&
    !params.slotCreated &&
    params.hadVisibleClient &&
    !params.visibleConnected
  );
}

export function cleanupVisibleClientLauncher(launch: VisibleClientLaunch): boolean {
  if (!launch.pid || !isPidAlive(launch.pid)) {
    return false;
  }

  try {
    killProcessTreeSync(launch.pid);
    return true;
  } catch {
    return false;
  }
}

export async function waitForVisibleClientConnection(
  params: {
    cwd: string;
    adapter: DaemonAdapterKind;
    instance?: number;
    timeoutMs?: number;
    pollMs?: number;
  },
  deps: {
    isAlive?: (cwd: string, adapter: DaemonAdapterKind, instance?: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const timeoutMs = params.timeoutMs ?? VISIBLE_CLIENT_CONNECT_TIMEOUT_MS;
  const pollMs = params.pollMs ?? VISIBLE_CLIENT_CONNECT_POLL_MS;
  const isAlive = deps.isAlive ?? isVisibleClientAlive;
  const sleepFn = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  while (true) {
    if (isAlive(params.cwd, params.adapter, params.instance)) {
      return true;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return false;
    }

    await sleepFn(Math.min(pollMs, remainingMs));
  }
}

export async function waitForCodexVisibleThread(
  params: {
    getThreadId: () => string | undefined;
    timeoutMs?: number;
    pollMs?: number;
  },
  deps: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<string | null> {
  const timeoutMs = params.timeoutMs ?? VISIBLE_CLIENT_CONNECT_TIMEOUT_MS;
  const pollMs = params.pollMs ?? VISIBLE_CLIENT_CONNECT_POLL_MS;
  const sleepFn = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  while (true) {
    const threadId = params.getThreadId();
    if (threadId) {
      return threadId;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return null;
    }

    await sleepFn(Math.min(pollMs, remainingMs));
  }
}
