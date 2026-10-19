#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BRIDGE_LOG_FILE, getWorkspaceChannelPaths } from "../wechat/channel-config.ts";
import {
  resolveCodexDaemonControlSocketPath,
} from "../bridge/bridge-adapters.codex.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import { ensureWecomAccount } from "../channels/wecom/setup.ts";
import { ensureTelegramAccount } from "../channels/telegram/setup.ts";
import {
  getBridgeChannelDisplayName,
  isBridgeChannelId,
  normalizeBridgeChannelId,
  type BridgeChannelId,
} from "../core/channel-types.ts";
import { isDirectModuleRun } from "../core/direct-run.ts";
import {
  readBridgeLockFile,
  shouldAutoReclaimBridgeLock,
  type BridgeLockPayload,
} from "../bridge/bridge-state.ts";
import {
  clearLocalCompanionOccupancy,
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "./local-companion-link.ts";
import type {
  BridgeAdapterKind,
  BridgeSessionStartMode,
} from "../bridge/bridge-types.ts";
import { runCodexRemoteClient } from "./codex-remote-client.ts";
import { runLocalCompanion } from "./local-companion.ts";
import {
  clearDaemonEndpoint,
  isDaemonEndpointAlive,
  readDaemonEndpoint,
  sendDaemonRequest,
  type DaemonEndpoint,
  type DaemonResponse,
} from "../daemon/daemon-link.ts";

type LocalCompanionLaunchAdapter = BridgeAdapterKind;

type LocalCompanionStartCliOptions = {
  adapter: LocalCompanionLaunchAdapter;
  cwd: string;
  profile?: string;
  timeoutMs: number;
  sessionStartMode: BridgeSessionStartMode;
  cliArgs: string[];
  channelId?: BridgeChannelId;
  /** Codex-only: attach the bridge to the live shared-daemon session in cwd. */
  attachCurrentSession?: boolean;
  codexThreadId?: string;
};

type EndpointReadResult = {
  endpoint: LocalCompanionEndpoint | null;
};

type EnsureBridgeReadyResult = {
  shouldOpenVisibleClient: boolean;
};

export type LocalCompanionLaunchDecision =
  | { kind: "already_active"; message: string }
  | { kind: "open_companion"; message: string }
  | { kind: "restart_unhealthy"; message: string }
  | {
      kind: "switch_workspace";
      fromCwd: string;
      toCwd: string;
      message: string;
      failureMessage: string;
    }
  | { kind: "start_bridge"; message: string };

type DecideLaunchActionInput = {
  requestedAdapter: LocalCompanionLaunchAdapter;
  requestedCwd: string;
  runningLock: BridgeLockPayload;
  lockShouldAutoReclaim: boolean;
  endpoint: LocalCompanionEndpoint | null;
  endpointIsReachable: boolean;
  companionIsAlive: boolean;
  sessionStartMode: BridgeSessionStartMode;
  requestedChannelId?: BridgeChannelId;
};

type VisibleClientRunners = {
  codexRemoteClient?: typeof runCodexRemoteClient;
  localCompanion?: typeof runLocalCompanion;
};

type EnsureWechatCredentialsFn = typeof ensureWechatCredentials;
type DaemonEndpointReader = typeof readDaemonEndpoint;
type DaemonEndpointAliveChecker = typeof isDaemonEndpointAlive;
type DaemonRequestSender = typeof sendDaemonRequest;
type DaemonEndpointClearer = typeof clearDaemonEndpoint;

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const RUNTIME_ENTRY_EXTENSION = path.extname(MODULE_FILE) === ".ts" ? ".ts" : ".js";
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_ADAPTER: LocalCompanionLaunchAdapter = "codex";

function log(
  options: Pick<LocalCompanionStartCliOptions, "adapter" | "channelId">,
  message: string,
): void {
  process.stderr.write(`[${options.channelId ?? "wechat"}-${options.adapter}] ${message}\n`);
}

export function normalizeComparablePath(cwd: string): string {
  const normalized = path.resolve(cwd);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isSameWorkspaceCwd(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

export function formatAlreadyActiveMessage(cwd: string): string {
  return `Current workspace is already active: ${cwd}. Visible companion is already running, so nothing else was opened.`;
}

export function formatSwitchMessage(fromCwd: string, toCwd: string): string {
  return `Detected active workspace ${fromCwd}. Switching to ${toCwd}...`;
}

export function formatSwitchFailureMessage(cwd: string): string {
  return `Failed to stop the previous workspace bridge. Switch canceled; current workspace remains ${cwd}.`;
}

export function formatRestartUnhealthyMessage(cwd: string): string {
  return `Detected unhealthy companion state for ${cwd}. Restarting bridge...`;
}

export function defaultSessionStartMode(
  _adapter: LocalCompanionLaunchAdapter,
): BridgeSessionStartMode {
  // Codex 0.155+ persists app-server threads lazily, so launching the visible
  // client with a freshly prepared (not yet persisted) thread id crashes its
  // bootstrap with "no rollout found". Start every adapter fresh by default;
  // explicit --session-start-mode restore remains available for deliberate
  // restores of already persisted threads.
  return "new";
}

export function decideLaunchAction(
  input: DecideLaunchActionInput,
): LocalCompanionLaunchDecision {
  if (input.lockShouldAutoReclaim) {
    return {
      kind: "start_bridge",
      message: `Detected reclaimable bridge lock for ${input.runningLock.cwd}. Replacing it for ${input.requestedCwd}...`,
    };
  }

  const sameWorkspace =
    input.runningLock.adapter === input.requestedAdapter &&
    (input.runningLock.channelId ?? "wechat") ===
      (input.requestedChannelId ?? "wechat") &&
    isSameWorkspaceCwd(input.runningLock.cwd, input.requestedCwd);

  if (!sameWorkspace) {
    return {
      kind: "switch_workspace",
      fromCwd: input.runningLock.cwd,
      toCwd: input.requestedCwd,
      message: formatSwitchMessage(input.runningLock.cwd, input.requestedCwd),
      failureMessage: formatSwitchFailureMessage(input.runningLock.cwd),
    };
  }

  if (
    input.sessionStartMode === "new" &&
    (input.requestedAdapter === "claude" ||
      input.requestedAdapter === "opencode" ||
      input.requestedAdapter === "pi" ||
      input.requestedAdapter === "codex")
  ) {
    return {
      kind: "start_bridge",
      message: `Starting a fresh ${input.requestedAdapter} session for ${input.requestedCwd}...`,
    };
  }

  if (!input.endpoint || !input.endpointIsReachable) {
    return {
      kind: "restart_unhealthy",
      message: formatRestartUnhealthyMessage(input.requestedCwd),
    };
  }

  if (
    input.companionIsAlive &&
    (input.endpoint.companionStatus === "stopped" ||
      input.endpoint.companionStatus === "error")
  ) {
    return {
      kind: "restart_unhealthy",
      message: formatRestartUnhealthyMessage(input.requestedCwd),
    };
  }

  if (input.endpoint && input.endpointIsReachable && input.companionIsAlive) {
    return {
      kind: "already_active",
      message: formatAlreadyActiveMessage(input.requestedCwd),
    };
  }

  return {
    kind: "open_companion",
    message: `Found running bridge for ${input.requestedCwd}. Opening companion...`,
  };
}

export function parseCliArgs(argv: string[]): LocalCompanionStartCliOptions {
  let adapter: LocalCompanionLaunchAdapter = DEFAULT_ADAPTER;
  let cwd = process.cwd();
  let profile: string | undefined;
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  let sessionStartMode: BridgeSessionStartMode | undefined;
  let channelId: BridgeChannelId = "wechat";
  let attachCurrentSession = false;
  let codexThreadId: string | undefined;
  const cliArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      const helpAdapter = adapter;
      const commandName = `${channelId}-${helpAdapter}`;
      const adapterLabel = {
        codex: "Codex",
        claude: "Claude Code",
        opencode: "OpenCode",
        pi: "Pi",
      }[helpAdapter];
      process.stdout.write(
        [
          `Usage: ${commandName} [--cwd <path>] [--profile <name-or-path>] [--timeout-ms <ms>] [--session-start-mode <restore|new>] [...${helpAdapter} args]`,
          "",
          `Ensures the ${getBridgeChannelDisplayName(channelId)} runtime for the current directory, then opens or reuses the visible CLI.`,
          "If a same-workspace daemon is running, the command delegates to that daemon.",
          `${adapterLabel} starts a fresh session by default.`,
          "Use --session-start-mode restore to explicitly restore the previous session.",
          "Use --doctor to check the selected adapter and workspace without starting it.",
          helpAdapter === "codex"
            ? `Use --attach-current-session to attach ${getBridgeChannelDisplayName(channelId)} to the live Codex daemon session in this directory (Codex >= 0.162 shared background server), instead of opening a visible client.`
            : "",
          "Without a daemon, the transient runtime is companion-bound and stops when the visible CLI closes.",
          "Unknown arguments are forwarded to the visible CLI client.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--doctor") {
      continue;
    }

    if (arg === "--channel") {
      if (!isBridgeChannelId(next) || next === "local") {
        throw new Error(`Invalid channel: ${next ?? "(missing)"}`);
      }
      channelId = next;
      i += 1;
      continue;
    }

    if (arg === "--adapter") {
      if (!next || !["codex", "claude", "opencode", "pi"].includes(next)) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      adapter = next as LocalCompanionLaunchAdapter;
      i += 1;
      continue;
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
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

    if (arg === "--timeout-ms") {
      if (!next) {
        throw new Error("--timeout-ms requires a value");
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1000) {
        throw new Error("--timeout-ms must be a number >= 1000");
      }
      timeoutMs = Math.trunc(parsed);
      i += 1;
      continue;
    }

    if (arg === "--session-start-mode") {
      if (!next || !["restore", "new"].includes(next)) {
        throw new Error(`Invalid session start mode: ${next ?? "(missing)"}`);
      }
      sessionStartMode = next as BridgeSessionStartMode;
      i += 1;
      continue;
    }

    if (arg === "--attach-current-session") {
      attachCurrentSession = true;
      continue;
    }

    if (arg === "--codex-thread-id") {
      if (!next) {
        throw new Error("--codex-thread-id requires a value");
      }
      codexThreadId = next;
      i += 1;
      continue;
    }

    cliArgs.push(arg);
  }

  if (attachCurrentSession && adapter !== "codex") {
    throw new Error("--attach-current-session requires the codex adapter");
  }

  return {
    adapter,
    cwd,
    profile,
    timeoutMs,
    sessionStartMode: sessionStartMode ?? defaultSessionStartMode(adapter),
    cliArgs,
    channelId,
    attachCurrentSession,
    codexThreadId,
  };
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !isPidAlive(pid);
}

async function stopExistingBridge(
  lock: BridgeLockPayload,
  options: Pick<LocalCompanionStartCliOptions, "adapter" | "channelId">,
): Promise<void> {
  const { pid, cwd } = lock;
  log(options, `Stopping existing bridge for ${cwd} (pid=${pid})...`);

  try {
    process.kill(pid);
  } catch (error) {
    if (isPidAlive(pid)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop existing bridge pid=${pid}: ${message}`, {
        cause: error,
      });
    }
  }

  if (!(await waitForProcessExit(pid, 10_000))) {
    throw new Error(`Timed out waiting for existing bridge pid=${pid} to exit.`);
  }

  if (
    lock.adapter === "codex" ||
    lock.adapter === "claude" ||
    lock.adapter === "opencode" ||
    lock.adapter === "pi"
  ) {
    clearLocalCompanionEndpoint(cwd, undefined, { adapter: lock.adapter });
  } else {
    clearLocalCompanionEndpoint(cwd);
  }
  log(
    options,
    `Cleared stale local companion endpoint for previous workspace ${cwd}.`,
  );
}

async function isEndpointReachable(endpoint: LocalCompanionEndpoint): Promise<boolean> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  return await new Promise<boolean>((resolve) => {
    const port = endpoint.serverPort ?? endpoint.port;
    const socket = net.connect({
      host: "127.0.0.1",
      port,
    });

    let done = false;
    const finish = (result: boolean) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readUsableEndpoint(
  options: Pick<LocalCompanionStartCliOptions, "cwd" | "adapter" | "channelId">,
): Promise<EndpointReadResult> {
  const { cwd, adapter } = options;
  const endpoint = readLocalCompanionEndpoint(cwd, { adapter });
  if (!endpoint || endpoint.kind !== adapter) {
    return { endpoint: null };
  }

  if (await isEndpointReachable(endpoint)) {
    return { endpoint };
  }

  clearLocalCompanionEndpoint(cwd, endpoint.instanceId, { adapter });
  log(options, `Removed stale local companion endpoint for ${cwd}.`);
  return { endpoint: null };
}

function isCompanionAlive(endpoint: LocalCompanionEndpoint | null): boolean {
  if (!endpoint?.companionPid) {
    return false;
  }

  if (isPidAlive(endpoint.companionPid)) {
    return true;
  }

  clearLocalCompanionOccupancy(endpoint.cwd, endpoint.instanceId, {
    adapter: endpoint.kind,
  });
  return false;
}

export function buildBackgroundBridgeArgs(
  entryPath: string,
  options: LocalCompanionStartCliOptions,
): string[] {
  // The attach bridge outlives this launcher (no visible client keeps the
  // foreground alive), so it must not be companion-bound to the launcher pid.
  const lifecycle = options.attachCurrentSession ? "persistent" : "companion_bound";
  const args = ["--no-warnings"];
  if (path.extname(entryPath) === ".ts") {
    args.push("--experimental-strip-types");
  }
  args.push(
    entryPath,
    "--adapter",
    options.adapter,
    "--cwd",
    options.cwd,
    "--lifecycle",
    lifecycle,
  );

  if (options.channelId) {
    args.push("--channel", options.channelId);
  }

  // Attach discovery owns thread selection; do not restore stale bridge state.
  const sessionStartMode = options.attachCurrentSession ? "new" : options.sessionStartMode;
  if (sessionStartMode !== "restore") {
    args.push("--session-start-mode", sessionStartMode);
  }

  if (options.profile) {
    args.push("--profile", options.profile);
  }

  if (options.attachCurrentSession) {
    args.push("--codex-attach-daemon");
    if (options.codexThreadId) {
      args.push("--codex-thread-id", options.codexThreadId);
    }
  }

  return args;
}

function startBridgeInBackground(options: LocalCompanionStartCliOptions): void {
  const entryPath = path.resolve(
    MODULE_DIR,
    "..",
    "bridge",
    `wechat-bridge${RUNTIME_ENTRY_EXTENSION}`,
  );
  const args = buildBackgroundBridgeArgs(entryPath, options);

  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  // A detached background spawn must still handle its own 'error' event
  // (e.g. ENOENT), otherwise it surfaces as an unhandled exception.
  child.on("error", () => {
    /* best effort: background bridge failed to detach */
  });

  child.unref();
}

async function waitForEndpoint(
  options: LocalCompanionStartCliOptions,
): Promise<LocalCompanionEndpoint> {
  const { cwd, adapter, timeoutMs } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await readUsableEndpoint(options);
    if (result.endpoint) {
      return result.endpoint;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for the ${adapter} bridge endpoint for ${cwd}. Check ${BRIDGE_LOG_FILE}.`,
  );
}

async function ensureBridgeReady(
  options: LocalCompanionStartCliOptions,
): Promise<EnsureBridgeReadyResult> {
  // If the lock is absent or the lock-holding process is dead, do NOT trust a
  // leftover endpoint.  The channel transport may have crashed while
  // the opencode server kept running.  Starting only the panel would leave no
  // bridge to receive channel messages.
  const lock = readBridgeLockFile();
  const lockProcessAlive = lock ? isPidAlive(lock.pid) : false;
  if (!lock || !lockProcessAlive) {
    if (lock && !lockProcessAlive) {
      log(options, `Found stale lock for ${options.cwd} (pid=${lock.pid} dead). Clearing.`);
      clearLocalCompanionEndpoint(options.cwd, undefined, {
        adapter: options.adapter,
      });
    }

    log(options, `Starting bridge in background for ${options.cwd}...`);
    startBridgeInBackground(options);
    await waitForEndpoint(options);
    return { shouldOpenVisibleClient: true };
  }

  // Lock is held by a live process; decide whether to reuse, switch, or replace it.
  const endpointResult = await readUsableEndpoint(options);
  const decision = decideLaunchAction({
    requestedAdapter: options.adapter,
    requestedCwd: options.cwd,
    runningLock: lock,
    lockShouldAutoReclaim: shouldAutoReclaimBridgeLock(lock),
    endpoint: endpointResult.endpoint,
    endpointIsReachable: Boolean(endpointResult.endpoint),
    companionIsAlive: isCompanionAlive(endpointResult.endpoint),
    sessionStartMode: options.sessionStartMode,
    requestedChannelId: options.channelId,
  });

  log(options, decision.message);

  if (decision.kind === "already_active") {
    return { shouldOpenVisibleClient: false };
  }

  if (decision.kind === "open_companion") {
    if (!endpointResult.endpoint) {
      await waitForEndpoint(options);
    }
    return { shouldOpenVisibleClient: true };
  }

  if (decision.kind === "switch_workspace") {
    try {
      await stopExistingBridge(lock, options);
    } catch (error) {
      log(options, decision.failureMessage);
      throw error;
    }
  } else {
    await stopExistingBridge(lock, options);
  }

  log(options, `Starting replacement bridge in background for ${options.cwd}...`);
  startBridgeInBackground(options);
  await waitForEndpoint(options);
  return { shouldOpenVisibleClient: true };
}

// The daemon's ensure_slot can legitimately take a while: opening a visible
// client waits up to 15s for it to connect, and codex waits another 15s for
// the visible thread — all serialized per adapter. The default 2s IPC timeout
// would expire on nearly every cold start, so delegation uses a generous
// deadline and falls back to a local bridge when the daemon cannot deliver.
const ENSURE_SLOT_DELEGATION_TIMEOUT_MS = 45_000;

export async function tryDelegateToDaemon(
  options: LocalCompanionStartCliOptions,
  deps: {
    readEndpoint?: DaemonEndpointReader;
    isEndpointAlive?: DaemonEndpointAliveChecker;
    sendRequest?: DaemonRequestSender;
    clearEndpoint?: DaemonEndpointClearer;
  } = {},
): Promise<boolean> {
  const readEndpoint = deps.readEndpoint ?? readDaemonEndpoint;
  const isEndpointAlive = deps.isEndpointAlive ?? isDaemonEndpointAlive;
  const sendRequest = deps.sendRequest ?? sendDaemonRequest;
  const clearEndpoint = deps.clearEndpoint ?? clearDaemonEndpoint;
  const endpoint: DaemonEndpoint | null = readEndpoint();
  if (!endpoint) {
    return false;
  }

  if (!(await isEndpointAlive(endpoint))) {
    clearEndpoint(endpoint.pid);
    return false;
  }

  const requestedChannel = options.channelId ?? "wechat";
  const endpointChannel = endpoint.channelId ?? "wechat";
  if (requestedChannel !== endpointChannel) {
    throw new Error(
      `${endpointChannel}-daemon is running for ${endpoint.cwd}. Stop it before starting the ${requestedChannel} channel.`,
    );
  }

  const response: DaemonResponse = await sendRequest(
    endpoint,
    {
      command: "ensure_slot",
      adapter: options.adapter,
      cwd: options.cwd,
      profile: options.profile,
      cliArgs: options.cliArgs,
      openVisible: true,
      sessionStartMode: options.sessionStartMode,
      reuseExistingVisible:
        options.adapter !== "pi" || options.sessionStartMode !== "new",
    },
    { timeoutMs: ENSURE_SLOT_DELEGATION_TIMEOUT_MS },
  );
  if (!response.ok) {
    // A daemon that cannot answer in time (or at all) must not abort the
    // launch: fall back to a local companion-bound bridge so the user still
    // gets a working terminal instead of an error for work the daemon may
    // still complete.
    log(
      options,
      `Daemon delegation failed (${response.error ?? "unknown error"}). Falling back to a local bridge.`,
    );
    return false;
  }

  log(
    options,
    `Delegated to running ${requestedChannel}-daemon for ${options.cwd}.`,
  );
  return true;
}

export async function runVisibleClient(
  options: LocalCompanionStartCliOptions,
  runners: VisibleClientRunners = {},
): Promise<number> {
  // Keep the foreground client in-process so Windows does not briefly flash an
  // extra bootstrap console before the real companion UI appears.
  if (options.adapter === "codex") {
    return await (runners.codexRemoteClient ?? runCodexRemoteClient)({
      cwd: options.cwd,
      cliArgs: options.cliArgs,
      sessionStartMode: options.sessionStartMode,
    });
  }

  return await (runners.localCompanion ?? runLocalCompanion)({
    adapter: options.adapter,
    cwd: options.cwd,
    sessionStartMode: options.sessionStartMode,
    cliArgs: options.cliArgs,
  });
}

export async function ensureCompanionStartWechatCredentials(
  adapter: LocalCompanionLaunchAdapter,
  ensureCredentials: EnsureWechatCredentialsFn = ensureWechatCredentials,
): Promise<void> {
  await ensureCredentials({
    requireUserId: true,
    validateExisting: true,
    log: (message) => log({ adapter, channelId: "wechat" }, message),
  });
}

const channelCredentialSetups = {
  wechat: async (options) => {
    await ensureCompanionStartWechatCredentials(options.adapter);
  },
  wecom: async (options) => {
    await ensureWecomAccount({
      log: (message) => log(options, message),
    });
  },
  telegram: async (options) => {
    await ensureTelegramAccount({
      log: (message) => log(options, message),
    });
  },
} satisfies Record<
  Exclude<BridgeChannelId, "local">,
  (options: Pick<LocalCompanionStartCliOptions, "adapter" | "channelId">) => Promise<void>
>;

export async function ensureCompanionStartChannelCredentials(
  options: Pick<LocalCompanionStartCliOptions, "adapter" | "channelId">,
): Promise<void> {
  const channelId = options.channelId ?? "wechat";
  if (channelId === "local") {
    throw new Error("The local channel does not support companion launchers.");
  }
  await channelCredentialSetups[channelId](options);
}

export async function runLocalCompanionStart(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck(argv, { mode: "bridge" });
    return 0;
  }

  const options = parseCliArgs(argv);
  await ensureCompanionStartChannelCredentials(options);

  if (options.attachCurrentSession) {
    return await runAttachCurrentSession(options);
  }

  if (await tryDelegateToDaemon(options)) {
    return 0;
  }

  const ready = await ensureBridgeReady(options);
  if (!ready.shouldOpenVisibleClient) {
    return 0;
  }
  return await runVisibleClient(options);
}

type AttachedBridgeState = {
  sharedThreadId: string;
};

export function resolveAttachedBridgeThreadId(
  state: unknown,
  lock: BridgeLockPayload | null,
  options: Pick<LocalCompanionStartCliOptions, "cwd" | "channelId" | "codexThreadId">,
): string | null {
  if (!lock || !state || typeof state !== "object") {
    return null;
  }
  const parsed = state as Record<string, unknown>;
  const channelId = options.channelId ?? "wechat";
  if (
    lock.adapter !== "codex" ||
    !isSameWorkspaceCwd(lock.cwd, options.cwd) ||
    (lock.channelId ?? "wechat") !== channelId ||
    parsed.instanceId !== lock.instanceId ||
    parsed.adapter !== "codex" ||
    typeof parsed.cwd !== "string" ||
    !isSameWorkspaceCwd(parsed.cwd, options.cwd) ||
    (parsed.channelId ?? "wechat") !== channelId ||
    typeof parsed.sharedThreadId !== "string" ||
    !parsed.sharedThreadId ||
    (options.codexThreadId && parsed.sharedThreadId !== options.codexThreadId)
  ) {
    return null;
  }
  return parsed.sharedThreadId;
}

export function formatAttachedBridgeMessage(
  options: Pick<LocalCompanionStartCliOptions, "cwd" | "channelId">,
  sharedThreadId: string,
): string {
  return `Attached Codex daemon thread ${sharedThreadId.slice(0, 8)} for ${options.cwd}. ${getBridgeChannelDisplayName(options.channelId ?? "wechat")} forwarding is active; the visible Codex session keeps running unchanged.`;
}

async function waitForAttachedBridgeState(
  options: LocalCompanionStartCliOptions,
): Promise<AttachedBridgeState> {
  const { cwd, timeoutMs } = options;
  const stateFile = getWorkspaceChannelPaths(cwd).stateFile;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const lock = readBridgeLockFile();
      const sharedThreadId = resolveAttachedBridgeThreadId(parsed, lock, options);
      if (sharedThreadId && lock && isPidAlive(lock.pid)) {
        return { sharedThreadId };
      }
    } catch {
      // Not written yet; keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for the attach bridge to bind a Codex thread for ${cwd}. Check ${BRIDGE_LOG_FILE}.`,
  );
}

/**
 * Attach flow: bind the selected channel to the live Codex shared-daemon session in the
 * workspace. No visible client is opened — the owning Codex TUI stays as-is —
 * so readiness is the persisted bridge state carrying the attached thread id.
 */
async function runAttachCurrentSession(options: LocalCompanionStartCliOptions): Promise<number> {
  const daemonEndpoint = readDaemonEndpoint();
  if (daemonEndpoint && (await isDaemonEndpointAlive(daemonEndpoint))) {
    const channel = daemonEndpoint.channelId ?? "wechat";
    throw new Error(
      `A ${channel}-daemon is running for ${daemonEndpoint.cwd}. Attach mode needs the workspace bridge lock; stop the daemon first or use its slots.`,
    );
  }

  const socketPath = resolveCodexDaemonControlSocketPath();
  if (!fs.existsSync(socketPath)) {
    throw new Error(
      `No shared Codex app-server daemon socket at ${socketPath}. Attach mode requires Codex >= 0.162 with its shared background server (the default). Sessions started with --no-daemon, --oss, or a --profile, and desktop-app embedded sessions, cannot be attached.`,
    );
  }

  const lock = readBridgeLockFile();
  if (lock) {
    if (isPidAlive(lock.pid)) {
      await stopExistingBridge(lock, options);
    } else {
      clearLocalCompanionEndpoint(options.cwd, undefined, { adapter: options.adapter });
      log(options, `Cleared stale bridge lock and endpoint for ${lock.cwd}.`);
    }
  }

  log(options, `Starting attach bridge in background for ${options.cwd}...`);
  startBridgeInBackground(options);
  const state = await waitForAttachedBridgeState(options);
  log(
    options,
    formatAttachedBridgeMessage(options, state.sharedThreadId),
  );
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const exitCode = await runLocalCompanionStart(argv);
    process.exit(exitCode);
  } catch (error) {
    // Argument validation may fail; retain the wrapper's channel and adapter
    // without running the failing parser again.
    const adapterIndex = argv.lastIndexOf("--adapter");
    const adapterValue = adapterIndex >= 0 ? argv[adapterIndex + 1] : undefined;
    const adapter = adapterValue && ["codex", "claude", "opencode", "pi"].includes(adapterValue)
      ? adapterValue as LocalCompanionLaunchAdapter
      : DEFAULT_ADAPTER;
    const channelIndex = argv.lastIndexOf("--channel");
    const channelId = normalizeBridgeChannelId(channelIndex >= 0 ? argv[channelIndex + 1] : undefined);
    log({ adapter, channelId }, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isDirectRun = isDirectModuleRun(
  import.meta.url,
  process.argv,
  (import.meta as ImportMeta & { main?: boolean }).main,
);
if (isDirectRun) {
  void main();
}
