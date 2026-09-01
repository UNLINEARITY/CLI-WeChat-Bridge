import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  normalizeBridgeLockPayload,
  shouldAutoReclaimBridgeLock,
  type BridgeLockPayload,
} from "../bridge/bridge-state.ts";
import type {
  BridgeAdapterKind,
  LegacyBridgeAdapterKind,
} from "../bridge/bridge-types.ts";
import {
  readLocalCompanionEndpoint as readWorkspaceEndpoint,
  type LocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";
import {
  isDaemonEndpointAlive,
  type DaemonEndpoint,
} from "../daemon/daemon-link.ts";
import { t } from "../i18n/index.ts";
import {
  DEFAULT_BASE_URL,
  getWorkspaceAdapterEndpointFile,
  getWorkspaceChannelPaths,
  resolveChannelDataDir,
} from "../wechat/channel-config.ts";

const STATE_OK = "[ok]";
const STATE_WARN = "[warn]";
const STATE_FAIL = "[fail]";

const RUNTIME_ENDPOINT_TIMEOUT_MS = 500;
const DAEMON_ENDPOINT_TIMEOUT_MS = 500;
const SERVER_DATE_TIMEOUT_MS = 3_000;
const CLOCK_SKEW_WARN_MS = 30_000;

type DoctorMode = "bridge" | "daemon" | "generic";
type DoctorStatus = "ok" | "warn" | "fail";

export type DoctorCliOptions = {
  mode: DoctorMode;
  cwd: string;
  adapter?: LegacyBridgeAdapterKind;
  channelId?: "wechat" | "wecom";
};

type FileReadResult<T> =
  | { kind: "missing"; filePath: string }
  | { kind: "invalid"; filePath: string; error: string }
  | { kind: "ok"; filePath: string; value: T };

export type DoctorDeps = {
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  osRelease?: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  getWindowsCodePage?: () => number | null;
  fetchServerDate?: (baseUrl?: string) => Promise<Date | null>;
  findExecutable?: (name: string) => string | null;
  loadNodePty?: () => Promise<void>;
  resolveDataDir?: () => string;
  exists?: (filePath: string) => boolean;
  readTextFile?: (filePath: string) => string;
  isProcessAlive?: (pid: number) => boolean;
  isTcpPortReachable?: (port: number, timeoutMs: number) => Promise<boolean>;
  isDaemonAlive?: (endpoint: DaemonEndpoint) => Promise<boolean>;
  readLocalCompanionEndpoint?: (
    cwd: string,
    adapter?: LegacyBridgeAdapterKind,
  ) => LocalCompanionEndpoint | null;
};

type ResolvedDoctorDeps = Required<DoctorDeps>;

type BuildDoctorReportOptions = {
  argv?: string[];
  mode?: DoctorMode;
  cwd?: string;
  adapter?: LegacyBridgeAdapterKind;
};

function msg(key: string, params?: Record<string, string | number>): string {
  return t(`doctor.${key}`, params);
}

function section(lines: string[], title: string): void {
  if (lines.length > 0 && lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push(title);
}

function row(status: string, label: string, value: string): string {
  return `  ${status} ${label} ${value}`;
}

function fieldRow(label: string, value: string): string {
  return `  ${label} ${value}`;
}

function detail(value: string): string {
  return `    ${value}`;
}

function detailField(label: string, value: string): string {
  return detail(`${label} ${value}`);
}

function findExecutable(name: string): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(cmd, [name], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim().split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}

function getPlatformPtyFix(platform: NodeJS.Platform): string {
  switch (platform) {
    case "linux":
      return "sudo apt install build-essential python3 && npm install -g cli-wechat-bridge@latest";
    case "darwin":
      return "xcode-select --install && npm rebuild node-pty";
    case "win32":
      return "npm rebuild node-pty (also ensure Visual C++ Redistributable is installed)";
    default:
      return "npm rebuild node-pty";
  }
}

function defaultGetWindowsCodePage(): number | null {
  try {
    const output = execFileSync("cmd.exe", ["/d", "/c", "chcp"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
    });
    const match = /(\d+)\s*\.?\s*$/.exec(output.trim());
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function defaultFetchServerDate(
  baseUrl = DEFAULT_BASE_URL,
): Promise<Date | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_DATE_TIMEOUT_MS);
  try {
    const res = await fetch(baseUrl, {
      method: "GET",
      signal: controller.signal,
    });
    const dateHeader = res.headers.get("date");
    if (!dateHeader) {
      return null;
    }
    const parsed = new Date(dateHeader);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function containsNonAscii(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) > 0x7f);
}

function pickProxyEnvValue(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    env.ALL_PROXY ??
    env.all_proxy
  )?.trim() || undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
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

async function defaultIsTcpPortReachable(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
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

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function resolveDeps(deps: DoctorDeps = {}): ResolvedDoctorDeps {
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    nodeVersion: deps.nodeVersion ?? process.version,
    osRelease: deps.osRelease ?? os.release,
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
    getWindowsCodePage: deps.getWindowsCodePage ?? defaultGetWindowsCodePage,
    fetchServerDate: deps.fetchServerDate ?? defaultFetchServerDate,
    findExecutable: deps.findExecutable ?? findExecutable,
    loadNodePty:
      deps.loadNodePty ??
      (async () => {
        await import("node-pty");
      }),
    resolveDataDir: deps.resolveDataDir ?? resolveChannelDataDir,
    exists: deps.exists ?? fs.existsSync,
    readTextFile:
      deps.readTextFile ??
      ((filePath) => fs.readFileSync(filePath, "utf8")),
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    isTcpPortReachable: deps.isTcpPortReachable ?? defaultIsTcpPortReachable,
    isDaemonAlive:
      deps.isDaemonAlive ??
      ((endpoint) =>
        isDaemonEndpointAlive(endpoint, { timeoutMs: DAEMON_ENDPOINT_TIMEOUT_MS })),
    readLocalCompanionEndpoint:
      deps.readLocalCompanionEndpoint ??
      ((cwd, adapter) =>
        readWorkspaceEndpoint(cwd, adapter ? { adapter } : {})),
  };
}

function isBridgeAdapterKind(value: string | undefined): value is BridgeAdapterKind {
  return (
    value === "codex" ||
    value === "claude" ||
    value === "opencode" ||
    value === "pi"
  );
}

export function parseDoctorCliArgs(
  argv: string[],
  mode: DoctorMode = "generic",
  fallbackCwd = process.cwd(),
): DoctorCliOptions {
  let cwd = fallbackCwd;
  let adapter: BridgeAdapterKind | undefined;
  let channelId: "wechat" | "wecom" = "wechat";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!arg) {
      continue;
    }

    if (arg === "--cwd" && next) {
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--adapter" && isBridgeAdapterKind(next)) {
      adapter = next;
      i += 1;
      continue;
    }

    if (arg === "--channel" && (next === "wechat" || next === "wecom")) {
      channelId = next;
      i += 1;
      continue;
    }
  }

  return {
    mode,
    cwd: path.resolve(cwd),
    adapter,
    ...(channelId === "wecom" ? { channelId } : {}),
  };
}

function statusTag(status: DoctorStatus): string {
  if (status === "ok") {
    return STATE_OK;
  }
  if (status === "warn") {
    return STATE_WARN;
  }
  return STATE_FAIL;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 100 ? `${message.slice(0, 100)}...` : message;
}

function sameWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizeDaemonEndpoint(value: unknown): DaemonEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.protocolVersion !== "number" ||
    typeof record.pid !== "number" ||
    typeof record.port !== "number" ||
    typeof record.token !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return null;
  }

  return {
    protocolVersion: record.protocolVersion,
    pid: record.pid,
    port: record.port,
    token: record.token,
    cwd: record.cwd,
    startedAt: record.startedAt,
  };
}

function readNormalizedJsonFile<T>(
  filePath: string,
  deps: ResolvedDoctorDeps,
  normalize: (value: unknown) => T | null,
): FileReadResult<T> {
  if (!deps.exists(filePath)) {
    return { kind: "missing", filePath };
  }

  try {
    const parsed = JSON.parse(deps.readTextFile(filePath)) as unknown;
    const normalized = normalize(parsed);
    if (!normalized) {
      return {
        kind: "invalid",
        filePath,
        error: msg("invalidShape"),
      };
    }
    return {
      kind: "ok",
      filePath,
      value: normalized,
    };
  } catch (error) {
    return {
      kind: "invalid",
      filePath,
      error: shortError(error),
    };
  }
}

function formatMode(mode: DoctorMode): string {
  if (mode === "bridge") {
    return msg("mode.bridge");
  }
  if (mode === "daemon") {
    return "wechat-daemon";
  }
  return msg("mode.generic");
}

function formatAlive(value: boolean | undefined): string {
  if (value === undefined) {
    return msg("unknown");
  }
  return value ? msg("yes") : msg("no");
}

function appendLockDetailLines(lines: string[], lock: BridgeLockPayload): void {
  lines.push(detailField(msg("lock.detail.pid"), String(lock.pid)));
  lines.push(detailField(msg("lock.detail.adapter"), lock.adapter));
  lines.push(detailField(msg("lock.detail.cwd"), lock.cwd));
  lines.push(detailField(msg("lock.detail.lifecycle"), lock.lifecycle));
  lines.push(detailField(msg("lock.detail.startedAt"), lock.startedAt));
}

async function appendDaemonLines(
  lines: string[],
  options: DoctorCliOptions,
  dataDir: string,
  deps: ResolvedDoctorDeps,
): Promise<void> {
  const endpointFile = path.join(dataDir, "daemon-endpoint.json");
  const endpointResult = readNormalizedJsonFile(
    endpointFile,
    deps,
    normalizeDaemonEndpoint,
  );
  const label = msg("label.daemon");

  if (endpointResult.kind === "missing") {
    lines.push(row(STATE_OK, label, msg("none")));
    return;
  }

  if (endpointResult.kind === "invalid") {
    lines.push(row(STATE_WARN, label, msg("daemon.invalid", {
      error: endpointResult.error,
    })));
    lines.push(detail(msg("file", { file: endpointResult.filePath })));
    return;
  }

  const endpoint = endpointResult.value;
  const pidAlive = deps.isProcessAlive(endpoint.pid);
  const daemonAlive = pidAlive ? await deps.isDaemonAlive(endpoint) : false;
  if (!daemonAlive) {
    lines.push(row(STATE_WARN, label, msg("daemon.stale", {
      pid: endpoint.pid,
      cwd: endpoint.cwd,
      port: endpoint.port,
    })));
    lines.push(detail(msg("daemon.staleStartup")));
    return;
  }

  const status: DoctorStatus = options.mode === "bridge" ? "fail" : "warn";
  lines.push(row(statusTag(status), label, msg("daemon.live", {
    pid: endpoint.pid,
    cwd: endpoint.cwd,
    port: endpoint.port,
  })));
  if (options.mode === "bridge") {
    lines.push(detail(msg("daemon.liveBridgeStartup")));
  } else if (options.mode === "daemon") {
    lines.push(detail(msg("daemon.liveDaemonStartup")));
  }
}

function appendBridgeLockLines(
  lines: string[],
  options: DoctorCliOptions,
  dataDir: string,
  deps: ResolvedDoctorDeps,
): BridgeLockPayload | null {
  const lockFile = path.join(dataDir, "bridge.lock.json");
  const lockResult = readNormalizedJsonFile(
    lockFile,
    deps,
    normalizeBridgeLockPayload,
  );
  const label = msg("label.bridgeLock");

  if (lockResult.kind === "missing") {
    lines.push(row(STATE_OK, label, msg("none")));
    return null;
  }

  if (lockResult.kind === "invalid") {
    lines.push(row(STATE_WARN, label, msg("lock.invalid", {
      error: lockResult.error,
    })));
    lines.push(detail(msg("file", { file: lockResult.filePath })));
    return null;
  }

  const lock = lockResult.value;
  const lockAlive = deps.isProcessAlive(lock.pid);
  const parentAlive =
    lock.parentPid > 1 ? deps.isProcessAlive(lock.parentPid) : undefined;
  const reclaimable = lockAlive
    ? shouldAutoReclaimBridgeLock(lock, deps.isProcessAlive)
    : false;

  if (!lockAlive) {
    lines.push(row(STATE_WARN, label, msg("lock.stale")));
    appendLockDetailLines(lines, lock);
    lines.push(
      detailField(
        msg("lock.detail.startup"),
        options.mode === "daemon"
          ? msg("lock.staleDaemonStartup")
          : msg("lock.staleBridgeStartup"),
      ),
    );
  } else if (reclaimable) {
    lines.push(row(STATE_WARN, label, msg("lock.reclaimable")));
    appendLockDetailLines(lines, lock);
    lines.push(detailField(msg("lock.detail.parent"), msg("lock.parent", {
      pid: lock.parentPid,
      alive: formatAlive(parentAlive),
    })));
    lines.push(
      detailField(
        msg("lock.detail.startup"),
        options.mode === "daemon"
          ? msg("lock.reclaimableDaemonStartup")
          : msg("lock.reclaimableBridgeStartup"),
      ),
    );
  } else if (options.mode === "daemon") {
    lines.push(row(STATE_WARN, label, msg("lock.live")));
    appendLockDetailLines(lines, lock);
    lines.push(detailField(
      msg("lock.detail.startup"),
      msg("lock.liveDaemonStartup"),
    ));
  } else {
    lines.push(row(STATE_FAIL, label, msg("lock.live")));
    appendLockDetailLines(lines, lock);
    lines.push(detailField(
      msg("lock.detail.startup"),
      msg("lock.liveBridgeStartup"),
    ));
  }

  if (!sameWorkspacePath(lock.cwd, options.cwd)) {
    lines.push(detailField(
      msg("lock.detail.note"),
      msg("lock.cwdDifferent", { cwd: options.cwd }),
    ));
  }
  if (options.adapter && lock.adapter !== options.adapter) {
    lines.push(detailField(
      msg("lock.detail.note"),
      msg("lock.adapterDifferent", {
        lockAdapter: lock.adapter,
        requestedAdapter: options.adapter,
      }),
    ));
  }

  return lock;
}

function chooseEndpointAdapters(
  options: DoctorCliOptions,
  lock: BridgeLockPayload | null,
): LegacyBridgeAdapterKind[] {
  if (options.adapter) {
    return [options.adapter];
  }
  if (lock) {
    return [lock.adapter];
  }
  return options.mode === "daemon"
    ? ["codex", "claude", "opencode", "pi"]
    : ["codex"];
}

function chooseCliChecks(options: DoctorCliOptions): Array<{
  name: string;
  label: string;
  optional: boolean;
}> {
  if (options.mode === "bridge") {
    switch (options.adapter) {
      case "codex":
        return [{ name: "codex", label: "Codex CLI", optional: false }];
      case "claude":
        return [{ name: "claude", label: "Claude CLI", optional: false }];
      case "opencode":
        return [{ name: "opencode", label: "OpenCode", optional: false }];
      case "pi":
        return [{ name: "pi", label: "Pi", optional: false }];
      default:
        return [];
    }
  }

  return [
    { name: "codex", label: "Codex CLI", optional: true },
    { name: "claude", label: "Claude CLI", optional: true },
    { name: "opencode", label: "OpenCode", optional: true },
    { name: "pi", label: "Pi", optional: true },
  ];
}

function appendCliLines(
  lines: string[],
  options: DoctorCliOptions,
  deps: ResolvedDoctorDeps,
): void {
  const clis = chooseCliChecks(options);
  if (clis.length === 0) {
    return;
  }

  section(lines, msg("section.adapterCli"));
  for (const cli of clis) {
    const loc = deps.findExecutable(cli.name);
    if (loc) {
      lines.push(row(STATE_OK, cli.label, loc));
    } else {
      lines.push(row(STATE_FAIL, cli.label, msg("adapterCli.notFound", {
        optional: cli.optional ? ` ${msg("optional")}` : "",
      })));
    }
  }
}

async function appendEndpointSummary(
  lines: string[],
  label: string,
  endpoint: LocalCompanionEndpoint | null,
  options: DoctorCliOptions,
  lock: BridgeLockPayload | null,
  deps: ResolvedDoctorDeps,
): Promise<void> {
  if (!endpoint) {
    lines.push(row(STATE_OK, label, msg("none")));
    return;
  }

  const port = endpoint.serverPort ?? endpoint.port;
  const reachable = await deps.isTcpPortReachable(
    port,
    RUNTIME_ENDPOINT_TIMEOUT_MS,
  );
  const bridgeOwnerAlive = endpoint.bridgeOwnerPid
    ? deps.isProcessAlive(endpoint.bridgeOwnerPid)
    : undefined;
  const companionAlive = endpoint.companionPid
    ? deps.isProcessAlive(endpoint.companionPid)
    : undefined;
  const issues: string[] = [];

  if (options.adapter && endpoint.kind !== options.adapter) {
    issues.push(msg("endpoint.issue.kind", {
      kind: endpoint.kind,
      adapter: options.adapter,
    }));
  }
  if (!sameWorkspacePath(endpoint.cwd, options.cwd)) {
    issues.push(msg("endpoint.issue.cwd", { cwd: options.cwd }));
  }
  if (!reachable) {
    issues.push(msg("endpoint.issue.port", { port }));
  }
  if (bridgeOwnerAlive === false) {
    issues.push(msg("endpoint.issue.ownerDead", {
      pid: endpoint.bridgeOwnerPid ?? msg("none"),
    }));
  }
  if (companionAlive === false) {
    issues.push(msg("endpoint.issue.companionDead", {
      pid: endpoint.companionPid ?? msg("none"),
    }));
  }
  if (
    endpoint.companionStatus === "stopped" ||
    endpoint.companionStatus === "error"
  ) {
    issues.push(msg("endpoint.issue.workerStatus", {
      status: endpoint.companionStatus,
    }));
  }
  if (
    lock &&
    endpoint.kind === lock.adapter &&
    sameWorkspacePath(endpoint.cwd, lock.cwd) &&
    endpoint.instanceId !== lock.instanceId
  ) {
    issues.push(msg("endpoint.issue.instanceMismatch"));
  }

  const status: DoctorStatus = issues.length > 0 ? "warn" : "ok";
  lines.push(row(statusTag(status), label, msg("endpoint.summary", {
    instanceId: endpoint.instanceId,
    kind: endpoint.kind,
    port,
    reachable: reachable ? msg("yes") : msg("no"),
  })));
  lines.push(detail(msg("endpoint.owner", {
    ownerPid: endpoint.bridgeOwnerPid ?? msg("none"),
    ownerAlive: formatAlive(bridgeOwnerAlive),
    companionPid: endpoint.companionPid ?? msg("none"),
    companionAlive: formatAlive(companionAlive),
    status: endpoint.companionStatus ?? msg("unknown"),
  })));
  for (const issue of issues) {
    lines.push(detail(msg("issue", { issue })));
  }
}

function endpointFileState(filePath: string): "missing" | "corrupted" | "readable" {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    return "readable";
  } catch {
    return "corrupted";
  }
}

async function appendWorkspaceEndpointLines(
  lines: string[],
  options: DoctorCliOptions,
  lock: BridgeLockPayload | null,
  deps: ResolvedDoctorDeps,
): Promise<void> {
  const adapters = chooseEndpointAdapters(options, lock);
  const seenEndpoints = new Set<string>();

  for (const adapter of adapters) {
    const endpoint = deps.readLocalCompanionEndpoint(options.cwd, adapter);
    if (endpoint) {
      seenEndpoints.add(`${endpoint.kind}:${endpoint.instanceId}:${endpoint.port}`);
    } else if (
      endpointFileState(getWorkspaceAdapterEndpointFile(options.cwd, adapter)) ===
      "corrupted"
    ) {
      // A torn or otherwise unparsable endpoint file must not read as a
      // healthy "none" — surface it so the operator knows to clear it.
      lines.push(
        row(
          STATE_WARN,
          msg("label.workspaceEndpoint", { adapter }),
          msg("endpoint.corrupted"),
        ),
      );
      continue;
    }
    await appendEndpointSummary(
      lines,
      msg("label.workspaceEndpoint", { adapter }),
      endpoint,
      { ...options, adapter },
      lock,
      deps,
    );
  }

  const legacyEndpoint = deps.readLocalCompanionEndpoint(options.cwd);
  const legacyLabel = msg("label.legacyEndpoint");
  if (!legacyEndpoint) {
    const legacyFileState = endpointFileState(
      getWorkspaceChannelPaths(options.cwd).endpointFile,
    );
    lines.push(
      row(
        legacyFileState === "corrupted" ? STATE_WARN : STATE_OK,
        legacyLabel,
        legacyFileState === "corrupted" ? msg("endpoint.corrupted") : msg("none"),
      ),
    );
    return;
  }

  const legacyKey = `${legacyEndpoint.kind}:${legacyEndpoint.instanceId}:${legacyEndpoint.port}`;
  if (seenEndpoints.has(legacyKey)) {
    lines.push(row(STATE_OK, legacyLabel, msg("endpoint.legacySame")));
    return;
  }

  await appendEndpointSummary(
    lines,
    legacyLabel,
    legacyEndpoint,
    options,
    lock,
    deps,
  );
}

export async function buildDoctorReport(
  options: BuildDoctorReportOptions = {},
  rawDeps: DoctorDeps = {},
): Promise<string[]> {
  const deps = resolveDeps(rawDeps);
  const parsed = parseDoctorCliArgs(
    options.argv ?? process.argv.slice(2),
    options.mode ?? "generic",
    options.cwd ?? process.cwd(),
  );
  const doctorOptions: DoctorCliOptions = {
    ...parsed,
    cwd: path.resolve(options.cwd ?? parsed.cwd),
    adapter: options.adapter ?? parsed.adapter,
  };
  const lines: string[] = [];

  lines.push(msg("title"));
  section(lines, msg("section.environment"));
  lines.push(row(STATE_OK, msg("label.node"), deps.nodeVersion));
  lines.push(row(STATE_OK, msg("label.platform"), `${deps.platform}-${deps.arch}`));

  if (deps.platform === "win32") {
    const release = deps.osRelease();
    const build = parseInt(release.split(".").pop() ?? "0", 10);
    const ok = build >= 18309;
    lines.push(row(
      ok ? STATE_OK : STATE_FAIL,
      msg("label.winBuild"),
      ok ? String(build) : `${build} ${msg("winBuildConpty")}`,
    ));

    const codePage = deps.getWindowsCodePage();
    if (codePage !== null) {
      const dataDirHasNonAscii = containsNonAscii(deps.resolveDataDir());
      const risky = codePage !== 65001 && dataDirHasNonAscii;
      lines.push(row(
        risky ? STATE_WARN : STATE_OK,
        msg("label.codePage"),
        risky
          ? msg("codePage.nonAsciiWarning", { codePage })
          : String(codePage),
      ));
    }
  }

  const proxyUrl = pickProxyEnvValue(deps.env);
  const connectivityUrl = doctorOptions.channelId === "wecom"
    ? "https://open.work.weixin.qq.com"
    : DEFAULT_BASE_URL;
  const serverDate = await deps.fetchServerDate(connectivityUrl);
  if (serverDate) {
    lines.push(row(
      STATE_OK,
      msg(
        doctorOptions.channelId === "wecom"
          ? "label.wecomConnectivity"
          : "label.connectivity",
      ),
      msg("connectivity.ok", {
        baseUrl: connectivityUrl,
      }),
    ));

    const skewMs = deps.now() - serverDate.getTime();
    const skewSeconds = Math.round(Math.abs(skewMs) / 1000);
    const clockOk = Math.abs(skewMs) <= CLOCK_SKEW_WARN_MS;
    lines.push(row(
      clockOk ? STATE_OK : STATE_WARN,
      msg("label.clock"),
      clockOk
        ? msg("clock.ok", { skewSeconds })
        : msg("clock.skewWarning", { skewSeconds }),
    ));
  } else {
    lines.push(row(
      STATE_WARN,
      msg(
        doctorOptions.channelId === "wecom"
          ? "label.wecomConnectivity"
          : "label.connectivity",
      ),
      proxyUrl && deps.env.NODE_USE_ENV_PROXY !== "1"
        ? msg("connectivity.proxyHint", { baseUrl: connectivityUrl, proxy: proxyUrl })
        : msg("connectivity.unreachable", { baseUrl: connectivityUrl }),
    ));
  }

  try {
    await deps.loadNodePty();
    lines.push(row(STATE_OK, msg("label.nodePty"), msg("nodePty.loaded")));
  } catch (error) {
    lines.push(row(STATE_FAIL, msg("label.nodePty"), shortError(error)));
    lines.push(detail(msg("nodePty.fix", { fix: getPlatformPtyFix(deps.platform) })));
  }

  appendCliLines(lines, doctorOptions, deps);

  section(lines, msg("section.data"));
  const dataDir = deps.resolveDataDir();
  const dataDirExists = deps.exists(dataDir);
  lines.push(row(
    dataDirExists ? STATE_OK : STATE_FAIL,
    msg("label.dataDir"),
    dataDirExists ? dataDir : `${dataDir} ${msg("dataDirMissing")}`,
  ));

  const credFile = doctorOptions.channelId === "wecom"
    ? path.join(dataDir, "wecom", "account.json")
    : path.join(dataDir, "account.json");
  const credExists = deps.exists(credFile);
  lines.push(row(
    credExists ? STATE_OK : STATE_FAIL,
    msg("label.credentials"),
    credExists
      ? msg("credentialsFound")
      : msg(
          doctorOptions.channelId === "wecom"
            ? "credentialsMissingWecom"
            : "credentialsMissing",
        ),
  ));

  section(lines, msg("section.runtime"));
  lines.push(fieldRow(msg("label.mode"), formatMode(doctorOptions.mode)));
  lines.push(fieldRow(msg("label.cwd"), doctorOptions.cwd));
  lines.push(fieldRow(
    msg("label.adapter"),
    doctorOptions.adapter ?? msg("notSpecified"),
  ));
  lines.push("");

  await appendDaemonLines(lines, doctorOptions, dataDir, deps);
  const lock = appendBridgeLockLines(lines, doctorOptions, dataDir, deps);
  await appendWorkspaceEndpointLines(lines, doctorOptions, lock, deps);

  lines.push("");
  return lines;
}

export async function runDoctorCheck(
  argv: string[] = process.argv.slice(2),
  options: { mode?: DoctorMode } = {},
): Promise<void> {
  const lines = await buildDoctorReport({
    argv,
    mode: options.mode ?? "generic",
  });
  process.stdout.write(lines.join("\n") + "\n");
}
