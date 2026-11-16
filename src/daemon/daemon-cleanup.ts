// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import { readBridgeLockFile, type BridgeLockPayload } from "../bridge/bridge-state.ts";
import {
  type BridgeProcessRecord,
  getProcessRecordByPid,
  isWechatDaemonCommandLine,
  killProcessTreeSync,
  listWechatDaemonProcesses,
} from "../bridge/bridge-process-reaper.ts";
import { formatDuration, truncatePreview } from "../bridge/bridge-utils.ts";
import { BRIDGE_LOCK_FILE } from "../wechat/channel-config.ts";
import { clearLocalCompanionEndpoint, readLocalCompanionEndpoint } from "../companion/local-companion-link.ts";
import {
  clearDaemonEndpoint,
  isPidAlive,
  readDaemonEndpoint,
  sendDaemonRequest,
  type DaemonEndpoint,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-link.ts";
import { DAEMON_ADAPTERS, appendDaemonLog, log, sleep } from "./daemon-shared.ts";

const SINGLE_BRIDGE_STOP_TIMEOUT_MS = 10_000;
const SINGLE_BRIDGE_FORCE_STOP_TIMEOUT_MS = 3_000;
const SINGLE_BRIDGE_STOP_POLL_MS = 250;
const DAEMON_TAKEOVER_STOP_TIMEOUT_MS = 10_000;
const DAEMON_TAKEOVER_FORCE_STOP_TIMEOUT_MS = 3_000;
const DAEMON_TAKEOVER_STOP_POLL_MS = 250;

export type DaemonCleanupResult =
  | { action: "none" }
  | { action: "cleared_stale_endpoint"; endpoint: DaemonEndpoint }
  | { action: "stopped"; endpoint: DaemonEndpoint; forced: boolean };

type DaemonCleanupDeps = {
  cwd?: string;
  readEndpoint?: () => DaemonEndpoint | null;
  isAlive?: (pid: number) => boolean;
  sendRequest?: (
    endpoint: DaemonEndpoint,
    payload: DaemonRequest,
    options?: { timeoutMs?: number },
  ) => Promise<DaemonResponse>;
  killProcess?: (pid: number) => void;
  clearEndpoint?: (pid?: number) => void;
  clearWorkspaceEndpoints?: (endpoint: DaemonEndpoint) => void;
  isDaemonProcess?: (endpoint: DaemonEndpoint) => boolean;
  listDaemonProcesses?: (cwd: string) => BridgeProcessRecord[];
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  daemonLog?: (message: string) => void;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  pollMs?: number;
};

function clearDaemonWorkspaceEndpoints(endpoint: DaemonEndpoint): void {
  for (const adapter of DAEMON_ADAPTERS) {
    // A companion endpoint with a live window must survive startup cleanup:
    // the codex adapter adopts it to reuse the app-server that is running the
    // task after a daemon restart. Only dead leftovers are cleared.
    const existing = readLocalCompanionEndpoint(endpoint.cwd, { adapter });
    if (existing?.companionPid && isPidAlive(existing.companionPid)) {
      continue;
    }
    clearLocalCompanionEndpoint(endpoint.cwd, undefined, { adapter });
  }
}

function isEndpointDaemonProcess(endpoint: DaemonEndpoint): boolean {
  const record = getProcessRecordByPid(endpoint.pid);
  return Boolean(record && isWechatDaemonCommandLine(record.commandLine));
}

function selectDaemonProcessesToStop(
  records: BridgeProcessRecord[],
  excludedPids: Set<number>,
): BridgeProcessRecord[] {
  const recordPids = new Set(records.map((record) => record.pid));
  return records.filter((record) => {
    if (excludedPids.has(record.pid)) {
      return false;
    }

    return !records.some(
      (candidate) =>
        candidate.parentPid === record.pid &&
        recordPids.has(candidate.pid) &&
        !excludedPids.has(candidate.pid),
    );
  });
}

async function stopDaemonPeerProcesses(params: {
  cwd: string;
  listDaemonProcesses: (cwd: string) => BridgeProcessRecord[];
  killProcess: (pid: number) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  daemonLog: (message: string) => void;
}): Promise<number[]> {
  const excludedPids = new Set([process.pid, process.ppid]);
  const peerRecords = selectDaemonProcessesToStop(
    params.listDaemonProcesses(params.cwd),
    excludedPids,
  );
  const stoppedPids: number[] = [];

  for (const peer of peerRecords) {
    params.daemonLog(
      `daemon_peer_takeover_attempt: pid=${peer.pid} cwd=${params.cwd} command=${truncatePreview(peer.commandLine, 400)}`,
    );
    params.killProcess(peer.pid);
    if (await waitForProcessExit({
      pid: peer.pid,
      timeoutMs: params.timeoutMs,
      pollMs: params.pollMs,
      isAlive: params.isAlive,
      sleep: params.sleep,
    })) {
      stoppedPids.push(peer.pid);
      params.daemonLog(`daemon_peer_takeover_complete: pid=${peer.pid}`);
    } else {
      params.daemonLog(`daemon_peer_takeover_timeout: pid=${peer.pid}`);
    }
  }

  return stoppedPids;
}

/**
 * Kill only daemon processes (this pid plus any wechat-daemon descendants).
 * Companion/TUI windows and the codex app-server — the process actually
 * running the task — are deliberately left alive, so a restarted daemon can
 * adopt the surviving app-server instead of interrupting long tasks.
 */
function killWechatDaemonProcesses(pid: number): void {
  const pending: number[] = [pid];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    try {
      process.kill(current, "SIGTERM");
    } catch {
      // Process already exited.
    }
    const children = listWechatDaemonProcesses({ cwd: undefined }).filter(
      (record) => record.parentPid === current,
    );
    for (const child of children) {
      pending.push(child.pid);
    }
  }
}

export async function cleanupDaemonBeforeStart(
  deps: DaemonCleanupDeps = {},
): Promise<DaemonCleanupResult> {
  const readEndpoint = deps.readEndpoint ?? readDaemonEndpoint;
  const isAlive = deps.isAlive ?? isPidAlive;
  const sendRequest = deps.sendRequest ?? sendDaemonRequest;
  const killProcess = deps.killProcess ?? killWechatDaemonProcesses;
  const clearEndpoint = deps.clearEndpoint ?? clearDaemonEndpoint;
  const clearWorkspaceEndpoints =
    deps.clearWorkspaceEndpoints ?? clearDaemonWorkspaceEndpoints;
  const isDaemonProcess = deps.isDaemonProcess ?? isEndpointDaemonProcess;
  const listDaemonProcesses =
    deps.listDaemonProcesses ??
    ((cwd: string) =>
      listWechatDaemonProcesses({
        cwd,
        excludePids: [process.pid, process.ppid],
      }));
  const sleepFn = deps.sleep ?? sleep;
  const cleanupLog = deps.log ?? log;
  const daemonLog = deps.daemonLog ?? appendDaemonLog;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DAEMON_TAKEOVER_STOP_TIMEOUT_MS;
  const forceStopTimeoutMs =
    deps.forceStopTimeoutMs ?? DAEMON_TAKEOVER_FORCE_STOP_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DAEMON_TAKEOVER_STOP_POLL_MS;
  const endpoint = readEndpoint();
  const cleanupCwd = endpoint?.cwd ?? deps.cwd;

  if (!endpoint) {
    if (cleanupCwd) {
      await stopDaemonPeerProcesses({
        cwd: cleanupCwd,
        listDaemonProcesses,
        killProcess,
        isAlive,
        sleep: sleepFn,
        timeoutMs: forceStopTimeoutMs,
        pollMs,
        daemonLog,
      });
    }
    return { action: "none" };
  }

  const clearDaemonArtifacts = () => {
    clearWorkspaceEndpoints(endpoint);
    clearEndpoint(endpoint.pid);
  };

  if (endpoint.pid === process.pid || !isAlive(endpoint.pid)) {
    cleanupLog(
      `Found stale wechat-daemon endpoint for ${endpoint.cwd} (pid=${endpoint.pid}). Cleaning it before daemon startup.`,
    );
    daemonLog(
      `daemon_stale_endpoint_cleanup: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
    );
    clearDaemonArtifacts();
    await stopDaemonPeerProcesses({
      cwd: endpoint.cwd,
      listDaemonProcesses,
      killProcess,
      isAlive,
      sleep: sleepFn,
      timeoutMs: forceStopTimeoutMs,
      pollMs,
      daemonLog,
    });
    return { action: "cleared_stale_endpoint", endpoint };
  }

  cleanupLog(
    `Found existing wechat-daemon for ${endpoint.cwd} (pid=${endpoint.pid}). Stopping it before daemon startup...`,
  );
  daemonLog(
    `daemon_takeover_attempt: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
  );

  let shutdownAcknowledged = false;
  try {
    const response = await sendRequest(
      endpoint,
      { command: "shutdown" },
      { timeoutMs: 1_000 },
    );
    if (response.ok) {
      shutdownAcknowledged = true;
    } else {
      daemonLog(
        `daemon_shutdown_request_failed: pid=${endpoint.pid} error=${truncatePreview(response.error, 400)}`,
      );
    }
  } catch (error) {
    daemonLog(
      `daemon_shutdown_request_failed: pid=${endpoint.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
    );
  }

  let forced = false;
  let stopped = await waitForProcessExit({
    pid: endpoint.pid,
    timeoutMs: stopTimeoutMs,
    pollMs,
    isAlive,
    sleep: sleepFn,
  });

  if (!stopped) {
    if (!shutdownAcknowledged && !isDaemonProcess(endpoint)) {
      daemonLog(
        `daemon_force_stop_skipped_unverified: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
      );
      clearDaemonArtifacts();
      await stopDaemonPeerProcesses({
        cwd: endpoint.cwd,
        listDaemonProcesses,
        killProcess,
        isAlive,
        sleep: sleepFn,
        timeoutMs: forceStopTimeoutMs,
        pollMs,
        daemonLog,
      });
      return { action: "cleared_stale_endpoint", endpoint };
    }

    forced = true;
    cleanupLog(
      `Existing daemon pid=${endpoint.pid} did not stop in ${formatDuration(stopTimeoutMs)}. Forcing cleanup...`,
    );
    daemonLog(
      `daemon_force_stop_attempt: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
    );
    try {
      killProcess(endpoint.pid);
    } catch (error) {
      if (isAlive(endpoint.pid)) {
        daemonLog(
          `daemon_force_stop_failed: pid=${endpoint.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    stopped = await waitForProcessExit({
      pid: endpoint.pid,
      timeoutMs: forceStopTimeoutMs,
      pollMs,
      isAlive,
      sleep: sleepFn,
    });
  }

  if (!stopped && isAlive(endpoint.pid)) {
    throw new Error(
      `Could not stop existing wechat-daemon automatically (pid=${endpoint.pid}, cwd=${endpoint.cwd}).`,
    );
  }

  clearDaemonArtifacts();
  cleanupLog(
    `Cleaned previous wechat-daemon for ${endpoint.cwd}; daemon startup can continue.`,
  );
  daemonLog(
    `daemon_takeover_complete: pid=${endpoint.pid} cwd=${endpoint.cwd} forced=${forced}`,
  );
  await stopDaemonPeerProcesses({
    cwd: endpoint.cwd,
    listDaemonProcesses,
    killProcess,
    isAlive,
    sleep: sleepFn,
    timeoutMs: forceStopTimeoutMs,
    pollMs,
    daemonLog,
  });
  return { action: "stopped", endpoint, forced };
}

export type SingleBridgeCleanupResult =
  | { action: "none" }
  | { action: "cleared_stale_lock"; lock: BridgeLockPayload }
  | { action: "stopped"; lock: BridgeLockPayload; forced: boolean };

type SingleBridgeCleanupDeps = {
  readLock?: () => BridgeLockPayload | null;
  isAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  clearLock?: (lock: BridgeLockPayload) => void;
  clearEndpoint?: (lock: BridgeLockPayload) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  daemonLog?: (message: string) => void;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  pollMs?: number;
};

async function waitForProcessExit(params: {
  pid: number;
  timeoutMs: number;
  pollMs: number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (!params.isAlive(params.pid)) {
      return true;
    }
    await params.sleep(Math.min(params.pollMs, deadline - Date.now()));
  }
  return !params.isAlive(params.pid);
}

function clearSingleBridgeLock(lock: BridgeLockPayload): void {
  try {
    const current = readBridgeLockFile();
    if (
      !current ||
      current.pid === lock.pid ||
      current.instanceId === lock.instanceId
    ) {
      fs.rmSync(BRIDGE_LOCK_FILE, { force: true });
    }
  } catch {
    // Best effort cleanup.
  }
}

function clearSingleBridgeEndpoint(lock: BridgeLockPayload): void {
  clearLocalCompanionEndpoint(lock.cwd, undefined, { adapter: lock.adapter });
}

export async function cleanupSingleBridgeBeforeDaemon(
  deps: SingleBridgeCleanupDeps = {},
): Promise<SingleBridgeCleanupResult> {
  const readLock = deps.readLock ?? readBridgeLockFile;
  const isAlive = deps.isAlive ?? isPidAlive;
  const killProcess = deps.killProcess ?? ((pid, signal) => {
    if (signal === "SIGKILL" || process.platform === "win32") {
      killProcessTreeSync(pid);
      return;
    }
    process.kill(pid, signal);
  });
  const clearLock = deps.clearLock ?? clearSingleBridgeLock;
  const clearEndpoint = deps.clearEndpoint ?? clearSingleBridgeEndpoint;
  const sleepFn = deps.sleep ?? sleep;
  const cleanupLog = deps.log ?? log;
  const daemonLog = deps.daemonLog ?? appendDaemonLog;
  const stopTimeoutMs = deps.stopTimeoutMs ?? SINGLE_BRIDGE_STOP_TIMEOUT_MS;
  const forceStopTimeoutMs =
    deps.forceStopTimeoutMs ?? SINGLE_BRIDGE_FORCE_STOP_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? SINGLE_BRIDGE_STOP_POLL_MS;
  const lock = readLock();

  if (!lock) {
    return { action: "none" };
  }

  const clearBridgeArtifacts = () => {
    clearEndpoint(lock);
    clearLock(lock);
  };

  if (!isAlive(lock.pid)) {
    cleanupLog(
      `Found stale single bridge lock for ${lock.cwd} (pid=${lock.pid} dead). Cleaning it before daemon startup.`,
    );
    daemonLog(
      `single_bridge_stale_cleanup: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd}`,
    );
    clearBridgeArtifacts();
    return { action: "cleared_stale_lock", lock };
  }

  cleanupLog(
    `Found existing single bridge for ${lock.cwd} (pid=${lock.pid}, adapter=${lock.adapter}). Stopping it before daemon startup...`,
  );
  daemonLog(
    `single_bridge_takeover_attempt: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd}`,
  );

  try {
    killProcess(lock.pid, "SIGTERM");
  } catch (error) {
    if (isAlive(lock.pid)) {
      daemonLog(
        `single_bridge_sigterm_failed: pid=${lock.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  let forced = false;
  let stopped = await waitForProcessExit({
    pid: lock.pid,
    timeoutMs: stopTimeoutMs,
    pollMs,
    isAlive,
    sleep: sleepFn,
  });

  if (!stopped) {
    forced = true;
    cleanupLog(
      `Single bridge pid=${lock.pid} did not stop in ${formatDuration(stopTimeoutMs)}. Forcing cleanup...`,
    );
    daemonLog(
      `single_bridge_force_stop_attempt: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd}`,
    );
    try {
      killProcess(lock.pid, "SIGKILL");
    } catch (error) {
      if (isAlive(lock.pid)) {
        daemonLog(
          `single_bridge_sigkill_failed: pid=${lock.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    stopped = await waitForProcessExit({
      pid: lock.pid,
      timeoutMs: forceStopTimeoutMs,
      pollMs,
      isAlive,
      sleep: sleepFn,
    });
  }

  if (!stopped && isAlive(lock.pid)) {
    throw new Error(
      `Could not stop existing single bridge automatically (pid=${lock.pid}, adapter=${lock.adapter}, cwd=${lock.cwd}).`,
    );
  }

  clearBridgeArtifacts();
  cleanupLog(
    `Cleaned previous single bridge for ${lock.cwd}; daemon startup can continue.`,
  );
  daemonLog(
    `single_bridge_takeover_complete: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd} forced=${forced}`,
  );
  return { action: "stopped", lock, forced };
}
