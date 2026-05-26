import { spawnSync } from "node:child_process";
import path from "node:path";

export type BridgeProcessRecord = {
  pid: number;
  parentPid?: number;
  name?: string;
  commandLine: string;
};

const PEER_BRIDGE_EXIT_TIMEOUT_MS = 4_000;
const PEER_BRIDGE_EXIT_POLL_MS = 100;

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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWechatBridgeCommandLine(commandLine: string): boolean {
  return (
    /wechat-bridge\.(?:ts|js|mjs)/i.test(commandLine) &&
    /(?:^|\s|["'])--adapter(?:(?:["']?\s)|=)/i.test(commandLine)
  );
}

export function isWechatDaemonCommandLine(commandLine: string): boolean {
  return /wechat-daemon\.(?:ts|js|mjs)/i.test(commandLine);
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function extractCommandLineOption(
  commandLine: string,
  optionName: string,
): string | null {
  const escaped = optionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\s|["'])--${escaped}(?:(?:["']?\\s+)|=)(?:"([^"]+)"|'([^']+)'|(\\S+))`,
    "i",
  );
  const match = pattern.exec(commandLine);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function isWechatDaemonCommandLineForCwd(
  commandLine: string,
  cwd: string,
): boolean {
  if (!isWechatDaemonCommandLine(commandLine)) {
    return false;
  }

  const commandCwd = extractCommandLineOption(commandLine, "cwd");
  if (!commandCwd) {
    return true;
  }

  return normalizeComparablePath(commandCwd) === normalizeComparablePath(cwd);
}

/**
 * Detects `opencode serve` command lines spawned by the bridge adapter.
 * Matches patterns like:
 *   opencode serve --port 12345 --hostname 127.0.0.1
 *   opencode.exe serve --port 12345
 * Also matches wrapper invocations (opencode.cmd / opencode.bat) on Windows.
 */
export function isOpencodeServeCommandLine(commandLine: string): boolean {
  return /\bopencode(?:\.exe|\.cmd|\.bat)?\b.*\bserve\b/i.test(commandLine);
}

/**
 * Detects `opencode attach` command lines spawned by the local OpenCode companion.
 * Matches patterns like:
 *   opencode attach http://127.0.0.1:12345
 *   opencode.exe attach http://127.0.0.1:12345 --session ses_123
 */
export function isOpencodeAttachCommandLine(commandLine: string): boolean {
  return /\bopencode(?:\.exe|\.cmd|\.bat)?\b.*\battach\b/i.test(commandLine);
}

function normalizeBridgeProcessRecord(value: unknown): BridgeProcessRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const pid =
    typeof value.ProcessId === "number"
      ? value.ProcessId
      : typeof value.pid === "number"
        ? value.pid
        : Number.NaN;
  const commandLine =
    typeof value.CommandLine === "string"
      ? value.CommandLine
      : typeof value.commandLine === "string"
        ? value.commandLine
        : "";
  if (!Number.isInteger(pid) || pid <= 0 || !commandLine) {
    return null;
  }

  const record: BridgeProcessRecord = {
    pid,
    commandLine,
  };
  const parentPid =
    typeof value.ParentProcessId === "number"
      ? value.ParentProcessId
      : typeof value.parentPid === "number"
        ? value.parentPid
        : undefined;
  if (typeof parentPid === "number" && Number.isInteger(parentPid) && parentPid > 0) {
    record.parentPid = parentPid;
  }
  const name =
    typeof value.Name === "string"
      ? value.Name
      : typeof value.name === "string"
        ? value.name
        : undefined;
  if (name) {
    record.name = name;
  }

  return record;
}

export function parseWindowsBridgeProcessProbeOutput(
  stdout: string,
  currentPid = process.pid,
): BridgeProcessRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values
    .map(normalizeBridgeProcessRecord)
    .filter((record): record is BridgeProcessRecord => Boolean(record))
    .filter(
      (record) => record.pid !== currentPid && isWechatBridgeCommandLine(record.commandLine),
    );
}

export function parsePosixBridgeProcessProbeOutput(
  stdout: string,
  currentPid = process.pid,
): BridgeProcessRecord[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) {
        return null;
      }
      const pid = Number(match[1]);
      const commandLine = match[2] ?? "";
      if (!Number.isInteger(pid) || pid <= 0 || !commandLine) {
        return null;
      }
      return {
        pid,
        commandLine,
      } satisfies BridgeProcessRecord;
    })
    .filter((record): record is BridgeProcessRecord => Boolean(record))
    .filter(
      (record) => record.pid !== currentPid && isWechatBridgeCommandLine(record.commandLine),
    );
}

function listWindowsBridgeProcesses(currentPid = process.pid): BridgeProcessRecord[] {
  const probe = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "Get-CimInstance Win32_Process",
        "| Where-Object { $_.CommandLine }",
        "| Select-Object ProcessId,ParentProcessId,Name,CommandLine",
        "| ConvertTo-Json -Compress",
      ].join(" "),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8_000,
    },
  );

  if (probe.status !== 0 || typeof probe.stdout !== "string") {
    return [];
  }

  return parseWindowsBridgeProcessProbeOutput(probe.stdout, currentPid);
}

function listPosixBridgeProcesses(currentPid = process.pid): BridgeProcessRecord[] {
  const probe = spawnSync(
    "ps",
    ["-ax", "-o", "pid=", "-o", "command="],
    {
      encoding: "utf8",
      timeout: 8_000,
    },
  );

  if (probe.status !== 0 || typeof probe.stdout !== "string") {
    return [];
  }

  return parsePosixBridgeProcessProbeOutput(probe.stdout, currentPid);
}

export function listPeerBridgeProcesses(currentPid = process.pid): BridgeProcessRecord[] {
  return process.platform === "win32"
    ? listWindowsBridgeProcesses(currentPid)
    : listPosixBridgeProcesses(currentPid);
}

export function getProcessRecordByPid(
  pid: number,
  currentPid = process.pid,
): BridgeProcessRecord | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) {
    return null;
  }
  return listAllProcessesRaw(currentPid).find((record) => record.pid === pid) ?? null;
}

export function listWechatDaemonProcesses(params: {
  cwd?: string;
  currentPid?: number;
  excludePids?: Iterable<number>;
} = {}): BridgeProcessRecord[] {
  const currentPid = params.currentPid ?? process.pid;
  const excludePids = new Set(params.excludePids ?? []);
  return listAllProcessesRaw(currentPid)
    .filter((record) => !excludePids.has(record.pid))
    .filter((record) =>
      params.cwd
        ? isWechatDaemonCommandLineForCwd(record.commandLine, params.cwd)
        : isWechatDaemonCommandLine(record.commandLine),
    );
}

/**
 * List all managed OpenCode child processes (`serve` and `attach`) whose parent
 * PID is no longer alive. These are orphaned processes left behind when a bridge
 * or local companion crashed or was killed without cleaning up its child
 * OpenCode processes.
 */
export function listOrphanedOpencodeProcesses(
  currentPid = process.pid,
): BridgeProcessRecord[] {
  const all = listAllProcessesRaw(currentPid);
  return all.filter((record) => {
    if (
      !isOpencodeServeCommandLine(record.commandLine) &&
      !isOpencodeAttachCommandLine(record.commandLine)
    ) {
      return false;
    }
    if (!record.parentPid) {
      return false;
    }
    if (record.parentPid === currentPid) {
      return false;
    }
    return !isPidAlive(record.parentPid);
  });
}

function listAllProcessesRaw(currentPid = process.pid): BridgeProcessRecord[] {
  if (process.platform === "win32") {
    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          "$ErrorActionPreference='Stop'",
          "Get-CimInstance Win32_Process",
          "| Where-Object { $_.CommandLine }",
          "| Select-Object ProcessId,ParentProcessId,Name,CommandLine",
          "| ConvertTo-Json -Compress",
        ].join(" "),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8_000,
      },
    );

    if (probe.status !== 0 || typeof probe.stdout !== "string") {
      return [];
    }

    const trimmed = probe.stdout.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values
        .map(normalizeBridgeProcessRecord)
        .filter((r): r is BridgeProcessRecord => Boolean(r))
        .filter((r) => r.pid !== currentPid);
    } catch {
      return [];
    }
  }

  const probe = spawnSync("ps", ["-ax", "-o", "pid=", "-o", "ppid=", "-o", "command="], {
    encoding: "utf8",
    timeout: 8_000,
  });

  if (probe.status !== 0 || typeof probe.stdout !== "string") {
    return [];
  }

  return probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const commandLine = match[3] ?? "";
      if (!Number.isInteger(pid) || pid <= 0 || !commandLine) return null;
      const record: BridgeProcessRecord = { pid, commandLine };
      if (Number.isInteger(parentPid) && parentPid > 0) record.parentPid = parentPid;
      return record;
    })
    .filter((r): r is BridgeProcessRecord => Boolean(r))
    .filter((r) => r.pid !== currentPid);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(Math.min(PEER_BRIDGE_EXIT_POLL_MS, deadline - Date.now()));
  }
  return !isPidAlive(pid);
}

/**
 * Synchronously kill a process and its entire descendant tree.
 * On Windows uses `taskkill /T /F /PID` to recursively kill all descendants.
 * On other platforms uses `process.kill(pid)` directly.
 */
export function killProcessTreeSync(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 5_000,
      });
    } catch {
      try { process.kill(pid); } catch { /* best effort */ }
    }
  } else {
    try { process.kill(-pid); } catch {
      try { process.kill(pid); } catch { /* best effort */ }
    }
  }
}

export async function reapPeerBridgeProcesses(params: {
  currentPid?: number;
  logger?: (message: string) => void;
} = {}): Promise<number[]> {
  const currentPid = params.currentPid ?? process.pid;
  const peers = listPeerBridgeProcesses(currentPid);
  const terminated: number[] = [];

  for (const peer of peers) {
    try {
      params.logger?.(
        `peer_bridge_reap_attempt: pid=${peer.pid}${peer.name ? ` name=${peer.name}` : ""} command=${peer.commandLine}`,
      );
      killProcessTreeSync(peer.pid);
      if (await waitForProcessExit(peer.pid, PEER_BRIDGE_EXIT_TIMEOUT_MS)) {
        terminated.push(peer.pid);
        params.logger?.(`peer_bridge_reaped: pid=${peer.pid}`);
      } else {
        params.logger?.(`peer_bridge_reap_timeout: pid=${peer.pid}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger?.(`peer_bridge_reap_failed: pid=${peer.pid} error=${message}`);
    }
  }

  return terminated;
}

/**
 * Kill orphaned managed OpenCode processes (`serve` and `attach`) whose parent
 * bridge/companion has already exited. These accumulate when a bridge crashes
 * or is killed without cleaning up its child OpenCode processes (common on
 * Windows where child processes are not automatically killed when the parent dies).
 */
export async function reapOrphanedOpencodeProcesses(params: {
  currentPid?: number;
  logger?: (message: string) => void;
} = {}): Promise<number[]> {
  const currentPid = params.currentPid ?? process.pid;
  const orphans = listOrphanedOpencodeProcesses(currentPid);
  const terminated: number[] = [];

  for (const orphan of orphans) {
    try {
      params.logger?.(
        `orphan_opencode_reap_attempt: pid=${orphan.pid}${orphan.name ? ` name=${orphan.name}` : ""} parentPid=${orphan.parentPid} command=${orphan.commandLine}`,
      );
      killProcessTreeSync(orphan.pid);
      if (await waitForProcessExit(orphan.pid, PEER_BRIDGE_EXIT_TIMEOUT_MS)) {
        terminated.push(orphan.pid);
        params.logger?.(`orphan_opencode_reaped: pid=${orphan.pid}`);
      } else {
        params.logger?.(`orphan_opencode_reap_timeout: pid=${orphan.pid}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger?.(`orphan_opencode_reap_failed: pid=${orphan.pid} error=${message}`);
    }
  }

  return terminated;
}
