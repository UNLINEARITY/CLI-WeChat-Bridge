#!/usr/bin/env bun

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  resolveDefaultAdapterCommand,
} from "../bridge/bridge-adapters.ts";
import { t } from "../i18n/index.ts";
import {
  delay,
  getSharedSessionIdFromAdapterState,
  quoteWindowsCommandArg,
} from "../bridge/bridge-adapters.shared.ts";
import { BridgeController } from "../bridge/bridge-controller.ts";
import { forwardWechatFinalReply } from "../bridge/bridge-final-reply.ts";
import {
  readBridgeLockFile,
  type BridgeLockPayload,
} from "../bridge/bridge-state.ts";
import {
  type BridgeProcessRecord,
  getProcessRecordByPid,
  isWechatDaemonCommandLine,
  killProcessTreeSync,
  listWechatDaemonProcesses,
  reapOrphanedOpencodeProcesses,
  reapPeerBridgeProcesses,
} from "../bridge/bridge-process-reaper.ts";
import type {
  BridgeAdapter,
  BridgeEvent,
  BridgeSessionStartMode,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "../bridge/bridge-types.ts";
import {
  buildOneTimeCode,
  buildWechatInboundPrompt,
  formatApprovalMessage,
  formatDuration,
  formatMirroredUserInputMessage,
  formatPendingApprovalReminder,
  formatPendingUserInputReminder,
  formatSessionSwitchMessage,
  formatTaskFailedMessage,
  formatUserInputRequestMessage,
  MESSAGE_START_GRACE_MS,
  nowIso,
  OutputBatcher,
  parsePendingUserInputAnswerCommand,
  parseWechatControlCommand,
  truncatePreview,
} from "../bridge/bridge-utils.ts";
import {
  ResumeSessionCoordinator,
  isWechatResumeEnabled,
  shouldForwardSessionSwitchEvent,
} from "../bridge/bridge-session-resume.ts";
import {
  WECHAT_SEND_MAX_ATTEMPTS,
  computeWechatSendRetryDelayMs,
  formatUserFacingBridgeFatalError,
  formatUserFacingInboundError,
  formatWechatContextTokenStaleLogEntry,
  formatWechatSendFailureLogEntry,
  isRetryableWechatSendError,
  shouldForwardBridgeEventToWechat,
  type WechatSendContext,
} from "../bridge/wechat-forwarding.ts";
import {
  BRIDGE_LOCK_FILE,
  BRIDGE_LOG_FILE,
  appendBoundedLog,
  ensureChannelDataDir,
  migrateLegacyChannelFiles,
} from "../wechat/channel-config.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import {
  formatBindCommandUsage,
  formatBindingsListMessage,
  isBindCommandPrefix,
  listBindings,
  loadEmojiBindings,
  parseEmojiBindingsCommand,
  removeBinding,
  resolveEmojiCommand,
  setBinding,
  type EmojiBindingsCommand,
} from "./emoji-bindings.ts";
import {
  classifyWechatTransportError,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  describeWechatTransportError,
  isWechatContextTokenStaleError,
  WeChatTransport,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  createRuntimeHost,
} from "../runtime/create-runtime-host.ts";
import {
  clearLocalCompanionEndpoint,
  clearLocalCompanionOccupancy,
  readLocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";
import {
  attachDaemonRequestListener,
  buildDaemonToken,
  clearDaemonEndpoint,
  DAEMON_PROTOCOL_VERSION,
  isPidAlive,
  readDaemonEndpoint,
  sendDaemonRequest,
  sendDaemonResponse,
  writeDaemonEndpoint,
  type DaemonAdapterKind,
  type DaemonEndpoint,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSlotSummary,
  type DaemonStatus,
} from "./daemon-link.ts";

type DaemonCliOptions = {
  cwd: string;
  profile?: string;
  initialAdapter?: DaemonAdapterKind;
  openVisible: boolean;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

type DaemonSlot = {
  adapter: DaemonAdapterKind;
  runtime: BridgeAdapter;
  controller: BridgeController;
  outputBatcher: OutputBatcher;
  pendingConfirmations: PendingApproval[];
  pendingUserInput: PendingUserInputRequest | null;
  resumeCoordinator: ResumeSessionCoordinator;
  activeTask: ActiveTask | null;
  lastOutputAt: number;
};

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const RUNTIME_ENTRY_EXTENSION = path.extname(MODULE_FILE) === ".ts" ? ".ts" : ".js";
const DAEMON_HOST = "127.0.0.1";
const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const SINGLE_BRIDGE_STOP_TIMEOUT_MS = 10_000;
const SINGLE_BRIDGE_FORCE_STOP_TIMEOUT_MS = 3_000;
const SINGLE_BRIDGE_STOP_POLL_MS = 250;
const DAEMON_TAKEOVER_STOP_TIMEOUT_MS = 10_000;
const DAEMON_TAKEOVER_FORCE_STOP_TIMEOUT_MS = 3_000;
const DAEMON_TAKEOVER_STOP_POLL_MS = 250;
const VISIBLE_CLIENT_CONNECT_TIMEOUT_MS = 15_000;
const VISIBLE_CLIENT_CONNECT_POLL_MS = 250;
const DAEMON_ADAPTERS: DaemonAdapterKind[] = ["codex", "claude", "opencode", "pi"];

function log(message: string): void {
  process.stderr.write(`[wechat-daemon] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-daemon] ERROR: ${message}\n`);
}

function appendDaemonLog(message: string): void {
  ensureChannelDataDir();
  appendBoundedLog(
    BRIDGE_LOG_FILE,
    `[${new Date().toISOString()}] daemon: ${message}\n`,
  );
}

function computePollRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, consecutiveFailures);
  const exponent = Math.min(normalizedFailures - 1, 5);
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** exponent);
}

function isDaemonAdapterKind(value: string | undefined): value is DaemonAdapterKind {
  return value === "codex" || value === "claude" || value === "opencode" || value === "pi";
}

function isSameWorkspaceCwd(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseDaemonCliArgs(argv: string[]): DaemonCliOptions {
  let cwd = process.cwd();
  let profile: string | undefined;
  let initialAdapter: DaemonAdapterKind | undefined;
  let openVisible = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: wechat-daemon [--cwd <path>] [--adapter <codex|claude|opencode|pi>] [--profile <name-or-path>] [--no-open]",
          "",
          "Keeps one WeChat connection alive and switches between Codex, Claude Code, OpenCode, and Pi from WeChat.",
          "Send /codex, /claude, /opencode, or /pi in WeChat to switch the active terminal.",
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

  return { cwd, profile, initialAdapter, openVisible };
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
  adapter: DaemonAdapterKind,
): BridgeSessionStartMode {
  return adapter === "codex" ? "restore" : "new";
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
  if (params.adapter === "codex") {
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

function toPendingApproval(request: BridgeEvent & { type: "approval_required" }): PendingApproval {
  const rawRequest = request.request;
  if (typeof (rawRequest as PendingApproval).code === "string") {
    return rawRequest as PendingApproval;
  }

  return {
    ...rawRequest,
    code: buildOneTimeCode(),
    createdAt: nowIso(),
  };
}

function toPendingUserInput(request: UserInputRequest | PendingUserInputRequest): PendingUserInputRequest {
  if (typeof (request as PendingUserInputRequest).createdAt === "string") {
    return request as PendingUserInputRequest;
  }

  return {
    ...request,
    createdAt: nowIso(),
  };
}

function prefixDaemonAdapterMessage(adapter: DaemonAdapterKind, text: string): string {
  const trimmed = text.trim();
  return trimmed ? `[${adapter}]\n${trimmed}` : `[${adapter}]`;
}

export function buildVisibleClientLaunchArgs(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
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
  args.push("--cwd", params.cwd, ...(params.cliArgs ?? []));
  return args;
}

export function buildWindowsVisibleClientLaunchCommand(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  args: string[];
}): string {
  return [
    "start",
    quoteWindowsCommandArg(`wechat-${params.adapter}`),
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

type VisibleClientLaunch = {
  command: string;
  args: string[];
  pid?: number;
};

function formatLaunchPreview(launch: VisibleClientLaunch): string {
  return [launch.command, ...launch.args].join(" ");
}

function openVisibleClient(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs?: string[];
  onError?: (error: Error) => void;
}): VisibleClientLaunch {
  const args = buildVisibleClientLaunchArgs(params);
  if (process.platform === "win32") {
    const command = process.env.ComSpec || "cmd.exe";
    const launchArgs = [
      "/d",
      "/c",
      buildWindowsVisibleClientLaunchCommand({
        adapter: params.adapter,
        cwd: params.cwd,
        args,
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

  const title = `wechat-${params.adapter}`;
  const fullArgs = [process.execPath, ...args];

  if (process.platform === "darwin") {
    const cmdLine = fullArgs.map(shellQuotePosix).join(" ");
    const script = `tell application "Terminal"
activate
do script "cd ${shellQuotePosix(params.cwd)} && exec ${cmdLine}"
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

function isVisibleClientAlive(cwd: string, adapter: DaemonAdapterKind): boolean {
  const endpoint = readLocalCompanionEndpoint(cwd, { adapter });
  if (!endpoint?.companionPid) {
    return false;
  }
  if (isPidAlive(endpoint.companionPid)) {
    return true;
  }

  clearLocalCompanionOccupancy(cwd, endpoint.instanceId, { adapter });
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

function cleanupVisibleClientLauncher(launch: VisibleClientLaunch): boolean {
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
    timeoutMs?: number;
    pollMs?: number;
  },
  deps: {
    isAlive?: (cwd: string, adapter: DaemonAdapterKind) => boolean;
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
    if (isAlive(params.cwd, params.adapter)) {
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

function formatInboundMessagePreview(message: InboundWechatMessage): string {
  if (message.text.trim()) {
    return message.text;
  }

  if (message.attachments.length > 0) {
    return message.attachments
      .map((attachment) => `${attachment.kind}: ${attachment.path}`)
      .join("\n");
  }

  return "(empty)";
}

function formatNoActiveAdapterMessage(): string {
  return [
    "No active terminal is selected.",
    "Send /codex, /claude, /opencode, or /pi to choose one.",
  ].join("\n");
}

export function formatDaemonSwitchResultDetail(result: {
  created: boolean;
  openedVisible: boolean;
  visibleConnected: boolean;
  visibleReady?: boolean;
  activated?: boolean;
  previousActiveAdapter?: DaemonAdapterKind;
}): string {
  if (result.activated === false) {
    const previous = result.previousActiveAdapter
      ? ` Active terminal remains ${result.previousActiveAdapter}.`
      : " No terminal is active yet.";
    if (result.visibleConnected && result.visibleReady === false) {
      return `The visible Codex CLI connected, but its active thread is not ready yet.${previous} Check ${BRIDGE_LOG_FILE}.`;
    }
    if (result.openedVisible) {
      return result.created
        ? `Started the bridge slot and tried to open the visible CLI, but it has not connected yet.${previous} Check ${BRIDGE_LOG_FILE}.`
        : `Tried to open a visible CLI for the existing slot, but it has not connected yet.${previous} Check ${BRIDGE_LOG_FILE}.`;
    }

    return `The visible CLI is not connected yet.${previous} Check ${BRIDGE_LOG_FILE}.`;
  }

  if (result.openedVisible && result.visibleConnected) {
    return result.created
      ? "Started a new visible CLI."
      : "Opened a visible CLI for the existing slot.";
  }

  if (result.openedVisible) {
    return result.created
      ? `Started the bridge slot and tried to open the visible CLI, but it has not connected yet. Check ${BRIDGE_LOG_FILE}.`
      : `Tried to open a visible CLI for the existing slot, but it has not connected yet. Check ${BRIDGE_LOG_FILE}.`;
  }

  if (result.visibleConnected) {
    return "Reused the existing visible CLI.";
  }

  return result.created ? "Started the bridge slot." : "Reused the bridge slot.";
}

export function formatDaemonStatus(status: DaemonStatus): string {
  const lines = [
    "wechat-daemon status",
    `cwd: ${status.cwd}`,
    `active: ${status.activeAdapter ?? "(none)"}`,
    `started_at: ${status.startedAt}`,
  ];

  for (const adapter of DAEMON_ADAPTERS) {
    const slot = status.slots.find((entry) => entry.adapter === adapter);
    if (!slot) {
      lines.push(`${adapter}: not started`);
      continue;
    }
    const flags = [
      slot.pendingApproval ? "pending_approval" : "",
      slot.pendingUserInput ? "pending_input" : "",
      slot.companionPid ? `companion_pid=${slot.companionPid}` : "",
    ].filter(Boolean);
    lines.push(`${adapter}: ${slot.status}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  }

  return lines.join("\n");
}

class WechatDaemon {
  private readonly cwd: string;
  private readonly profile?: string;
  private readonly authorizedUserId: string;
  private readonly transport: WeChatTransport;
  private readonly slots = new Map<DaemonAdapterKind, DaemonSlot>();
  // Per-adapter serialization chains for ensureSlot (see ensureSlot comment).
  private readonly slotEnsureChains = new Map<DaemonAdapterKind, Promise<unknown>>();
  private readonly startedAt = new Date().toISOString();
  private readonly bridgeStartedAtMs = Date.now();
  private backlogNoticeSent = false;
  private activeAdapter: DaemonAdapterKind | null = null;
  takenOverAdapter?: DaemonAdapterKind;
  private textSendChain = Promise.resolve();
  private attachmentSendChain = Promise.resolve();
  private readonly pendingWechatForwardTasks = new Set<Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;
  private ipcServer: net.Server | null = null;
  private endpointToken = "";

  constructor(params: {
    cwd: string;
    profile?: string;
    authorizedUserId: string;
    transport: WeChatTransport;
  }) {
    this.cwd = params.cwd;
    this.profile = params.profile;
    this.authorizedUserId = params.authorizedUserId;
    this.transport = params.transport;
  }

  async startIpcServer(): Promise<void> {
    this.endpointToken = buildDaemonToken();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        let detach: (() => void) | null = null;
        detach = attachDaemonRequestListener(socket, (frame) => {
          if (frame.token !== this.endpointToken) {
            sendDaemonResponse(socket, frame.id, {
              ok: false,
              error: "Invalid daemon IPC token.",
            });
            return;
          }

          void this.handleDaemonRequest(frame.payload).then(
            (result) => {
              sendDaemonResponse(socket, frame.id, { ok: true, result });
            },
            (error) => {
              sendDaemonResponse(socket, frame.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
        });
        socket.once("close", () => {
          detach?.();
          detach = null;
        });
        socket.once("error", () => {
          socket.destroy();
        });
      });
      this.ipcServer = server;
      server.once("error", reject);
      server.listen(0, DAEMON_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate daemon IPC port."));
          return;
        }

        writeDaemonEndpoint({
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          pid: process.pid,
          port: address.port,
          token: this.endpointToken,
          cwd: this.cwd,
          startedAt: this.startedAt,
        });
        resolve();
      });
    });
  }

  getStatus(): DaemonStatus {
    return {
      cwd: this.cwd,
      activeAdapter: this.activeAdapter ?? undefined,
      startedAt: this.startedAt,
      slots: Array.from(this.slots.values()).map((slot): DaemonSlotSummary => {
        const endpoint = readLocalCompanionEndpoint(this.cwd, {
          adapter: slot.adapter,
        });
        return {
          adapter: slot.adapter,
          status: slot.runtime.getState().status,
          cwd: this.cwd,
          companionPid: endpoint?.companionPid,
          pendingApproval: slot.pendingConfirmations.length > 0,
          pendingUserInput: Boolean(slot.pendingUserInput),
        };
      }),
    };
  }

  async runInitialAdapter(options: DaemonCliOptions): Promise<void> {
    if (!options.initialAdapter) {
      return;
    }

    await this.ensureSlot(options.initialAdapter, {
      profile: options.profile,
      openVisible: options.openVisible,
    });
  }

  async runPollLoop(): Promise<void> {
    let consecutivePollFailures = 0;
    log("WeChat daemon is ready.");
    log(`Working directory: ${this.cwd}`);
    log("Switch from WeChat with /codex, /claude, /opencode, or /pi.");
    appendDaemonLog(`started: cwd=${this.cwd}`);

    const activeSlot = this.getActiveSlot();
    const welcomeText = t("daemon.welcome", {
      cwd: this.cwd,
      adapter: activeSlot?.adapter ?? "none",
      bindings: formatBindingsListMessage(listBindings()),
    });
    await this.queueWechatMessage(this.authorizedUserId, welcomeText);

    while (!this.shutdownPromise) {
      let pollResult: Awaited<ReturnType<WeChatTransport["pollMessages"]>>;
      try {
        pollResult = await this.transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: this.bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
      } catch (error) {
        const classification = classifyWechatTransportError(error);
        if (!classification.retryable) {
          throw error;
        }

        consecutivePollFailures += 1;
        const delayMs = computePollRetryDelayMs(consecutivePollFailures);
        const errorText = describeWechatTransportError(error);
        const statusDetails =
          typeof classification.statusCode === "number"
            ? ` status=${classification.statusCode}`
            : "";
        logError(
          `WeChat long poll failed (${classification.kind}${statusDetails}, attempt ${consecutivePollFailures}). Retrying in ${formatDuration(delayMs)}. ${errorText}`,
        );
        appendDaemonLog(
          `poll_retry: kind=${classification.kind}${statusDetails} attempt=${consecutivePollFailures} delay_ms=${delayMs} error=${truncatePreview(errorText, 400)}`,
        );
        await delay(delayMs);
        continue;
      }

      if (consecutivePollFailures > 0) {
        log(`WeChat long poll recovered after ${consecutivePollFailures} transient error(s).`);
        appendDaemonLog(`poll_recovered: failures=${consecutivePollFailures}`);
        consecutivePollFailures = 0;
      }

      if (pollResult.ignoredBacklogCount > 0) {
        appendDaemonLog(`ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`);
        if (!this.backlogNoticeSent) {
          this.backlogNoticeSent = true;
          await this.queueWechatMessage(
            this.authorizedUserId,
            t("bridge.backlogIgnored", {
              count: pollResult.ignoredBacklogCount,
              graceSeconds: Math.round(MESSAGE_START_GRACE_MS / 1000),
            }),
            "notice",
          );
        }
      }

      for (const message of pollResult.messages) {
        try {
          await this.handleInboundMessage(message);
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          logError(errorText);
          appendDaemonLog(`inbound_error: ${errorText}`);
          await this.queueWechatMessage(
            message.senderId,
            formatUserFacingInboundError({
              adapter: this.activeAdapter ?? "codex",
              cwd: this.cwd,
              errorText,
            }),
            "inbound_error",
          );
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.cleanup();
    }
    await this.shutdownPromise;
  }

  /**
   * Remove a slot whose runtime reported a fatal (terminal) error. The dead
   * runtime would otherwise stay in the slot map forever: every later message
   * would fail against it ("adapter is not running") with no path back to a
   * working adapter short of a manual /reset or daemon restart. After removal,
   * the next switch directive (/codex etc.) rebuilds the adapter from scratch.
   */
  private disposeDeadSlot(slot: DaemonSlot): void {
    if (this.slots.get(slot.adapter) !== slot) {
      return; // Already replaced by a newer ensureSlot run.
    }
    this.slots.delete(slot.adapter);
    if (this.activeAdapter === slot.adapter) {
      this.activeAdapter = null;
    }
    appendDaemonLog(`dead_slot_disposed: adapter=${slot.adapter}`);
    void (async () => {
      try {
        await slot.runtime.dispose();
      } catch {
        // Best effort: the runtime already reported a fatal error.
      }
      slot.controller.clearLocalClientEndpoint();
    })();
  }

  private async cleanup(): Promise<void> {
    appendDaemonLog("shutdown_started");
    for (const slot of this.slots.values()) {
      try {
        await slot.outputBatcher.flushNow();
      } catch {
        // Best effort flush.
      }
    }
    await this.waitForPendingWechatForwardTasks();
    await this.textSendChain.catch(() => undefined);
    await this.attachmentSendChain.catch(() => undefined);

    for (const slot of this.slots.values()) {
      try {
        await slot.runtime.dispose();
      } catch {
        // Best effort shutdown.
      }
      slot.controller.clearLocalClientEndpoint();
    }
    this.slots.clear();

    if (this.ipcServer) {
      const server = this.ipcServer;
      this.ipcServer = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    clearDaemonEndpoint();
    appendDaemonLog("shutdown_complete");
  }

  private async handleDaemonRequest(request: DaemonRequest): Promise<unknown> {
    switch (request.command) {
      case "status":
        return this.getStatus();
      case "shutdown":
        setTimeout(() => {
          void this.shutdown().finally(() => process.exit(0));
        }, 0);
        return { shuttingDown: true };
      case "ensure_slot":
        if (!isSameWorkspaceCwd(request.cwd, this.cwd)) {
          throw new Error(
            `wechat-daemon is bound to ${this.cwd}; requested cwd was ${request.cwd}.`,
          );
        }
        return await this.ensureSlot(request.adapter, {
          profile: request.profile,
          cliArgs: request.cliArgs,
          openVisible: request.openVisible ?? true,
          sessionStartMode: request.sessionStartMode,
          reuseExistingVisible: request.reuseExistingVisible ?? true,
        });
      case "switch_adapter":
        return await this.ensureSlot(request.adapter, {
          profile: request.profile,
          cliArgs: request.cliArgs,
          openVisible: request.openVisible ?? true,
          sessionStartMode: request.sessionStartMode,
          reuseExistingVisible: request.reuseExistingVisible ?? true,
        });
    }
  }

  private async ensureSlot(
    adapter: DaemonAdapterKind,
    options: {
      profile?: string;
      cliArgs?: string[];
      openVisible?: boolean;
      sessionStartMode?: BridgeSessionStartMode;
      reuseExistingVisible?: boolean;
    } = {},
  ): Promise<{
    activeAdapter: DaemonAdapterKind;
    created: boolean;
    openedVisible: boolean;
    visibleConnected: boolean;
    visibleReady: boolean;
    activated: boolean;
    previousActiveAdapter?: DaemonAdapterKind;
  }> {
    // Serialize per-adapter ensureSlot runs. The IPC handler, the WeChat poll
    // loop, and startup can all call this concurrently; without serialization
    // two callers would both observe an empty slot map, create two runtimes,
    // and the second slots.set would orphan the first (duplicate PTY child,
    // double visible client, endpoint files overwriting each other).
    const tail = this.slotEnsureChains.get(adapter) ?? Promise.resolve();
    const run = tail.then(
      () => this.runEnsureSlot(adapter, options),
      // A rejected predecessor must not block this run — start fresh either way.
      () => this.runEnsureSlot(adapter, options),
    );
    this.slotEnsureChains.set(
      adapter,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async runEnsureSlot(
    adapter: DaemonAdapterKind,
    options: {
      profile?: string;
      cliArgs?: string[];
      openVisible?: boolean;
      sessionStartMode?: BridgeSessionStartMode;
      reuseExistingVisible?: boolean;
    } = {},
  ): Promise<{
    activeAdapter: DaemonAdapterKind;
    created: boolean;
    openedVisible: boolean;
    visibleConnected: boolean;
    visibleReady: boolean;
    activated: boolean;
    previousActiveAdapter?: DaemonAdapterKind;
  }> {
    const previousActiveAdapter = this.activeAdapter ?? undefined;
    let slot = this.slots.get(adapter);
    let created = false;
    if (!slot) {
      const createSessionStartMode =
        options.sessionStartMode ??
        (adapter === this.takenOverAdapter ? "restore" : defaultDaemonSessionStartMode(adapter));
      if (adapter === this.takenOverAdapter) {
        this.takenOverAdapter = undefined;
      }
      slot = await this.createSlot(adapter, {
        profile: options.profile ?? this.profile,
        sessionStartMode: createSessionStartMode,
      });
      this.slots.set(adapter, slot);
      created = true;
    }

    let openedVisible = false;
    const visibleEndpointBeforeProbe = readLocalCompanionEndpoint(this.cwd, {
      adapter,
    });
    const hadVisibleClient = Boolean(
      visibleEndpointBeforeProbe?.companionPid ||
        visibleEndpointBeforeProbe?.companionConnectedAt ||
        visibleEndpointBeforeProbe?.sharedThreadId ||
        visibleEndpointBeforeProbe?.sharedSessionId,
    );
    let visibleConnected = isVisibleClientAlive(this.cwd, adapter);
    if (
      shouldRestartDeadCodexVisibleRuntime({
        adapter,
        slotCreated: created,
        hadVisibleClient,
        visibleConnected,
      })
    ) {
      await this.startFreshSlotSession(slot);
      appendDaemonLog(
        `dead_visible_codex_runtime_restarted: cwd=${this.cwd}`,
      );
    }
    const sharedSessionBeforeVisible = getSharedSessionIdFromAdapterState(
      slot.runtime.getState(),
    );
    const sessionStartMode = resolveDaemonSessionStartMode({
      adapter,
      explicitSessionStartMode: options.sessionStartMode,
      slotCreated: created,
      visibleConnected,
      sharedSessionId: getSharedSessionIdFromAdapterState(slot.runtime.getState()),
      reuseExistingVisible: options.reuseExistingVisible !== false,
    });
    if (
      !created &&
      (options.reuseExistingVisible === false ||
        options.sessionStartMode === "new") &&
      sessionStartMode === "new" &&
      (adapter === "claude" || adapter === "opencode" || adapter === "pi") &&
      visibleConnected
    ) {
      await this.startFreshSlotSession(slot);
      appendDaemonLog(`fresh_session_started: adapter=${adapter} source=start_command`);
    }

    if (options.openVisible !== false && !visibleConnected) {
      slot.controller.syncLocalClientEndpoint();
      const launch = openVisibleClient({
        adapter,
        cwd: this.cwd,
        sessionStartMode,
        cliArgs: options.cliArgs,
        onError: (error) => {
          appendDaemonLog(
            `visible_client_open_error: adapter=${adapter} error=${truncatePreview(error.message, 400)}`,
          );
        },
      });
      openedVisible = true;
      appendDaemonLog(
        `visible_client_open_attempt: adapter=${adapter} cwd=${this.cwd} pid=${launch.pid ?? "unknown"} command=${truncatePreview(formatLaunchPreview(launch), 400)}`,
      );
      visibleConnected = await waitForVisibleClientConnection({
        cwd: this.cwd,
        adapter,
      });
      if (visibleConnected) {
        appendDaemonLog(`visible_client_connected: adapter=${adapter} cwd=${this.cwd}`);
      } else {
        log(
          `${adapter} visible CLI did not connect within ${formatDuration(VISIBLE_CLIENT_CONNECT_TIMEOUT_MS)}. Check ${BRIDGE_LOG_FILE}.`,
        );
        const cleanedLauncher = cleanupVisibleClientLauncher(launch);
        appendDaemonLog(
          `visible_client_connect_timeout: adapter=${adapter} cwd=${this.cwd} timeout_ms=${VISIBLE_CLIENT_CONNECT_TIMEOUT_MS} cleaned_launcher=${cleanedLauncher}`,
        );
      }
    }

    let visibleReady = visibleConnected;
    if (adapter === "codex" && visibleConnected && !sharedSessionBeforeVisible) {
      const visibleThreadId = await waitForCodexVisibleThread({
        getThreadId: () => {
          const state = slot.runtime.getState();
          if (state.lastThreadSwitchSource !== "local") {
            return undefined;
          }
          return state.sharedThreadId ?? state.sharedSessionId;
        },
      });
      visibleReady = Boolean(visibleThreadId);
      if (visibleThreadId) {
        appendDaemonLog(
          `visible_codex_thread_ready: thread=${visibleThreadId} cwd=${this.cwd}`,
        );
      } else {
        appendDaemonLog(
          `visible_codex_thread_timeout: cwd=${this.cwd} timeout_ms=${VISIBLE_CLIENT_CONNECT_TIMEOUT_MS}`,
        );
      }
    }

    const activated = options.openVisible === false || (visibleConnected && visibleReady);
    if (activated) {
      this.activeAdapter = adapter;
    }

    appendDaemonLog(
      `switch_adapter: adapter=${adapter} created=${created} opened_visible=${openedVisible} visible_connected=${visibleConnected} visible_ready=${visibleReady} activated=${activated} previous_active=${previousActiveAdapter ?? "(none)"} session_start_mode=${sessionStartMode}`,
    );
    return {
      activeAdapter: adapter,
      created,
      openedVisible,
      visibleConnected,
      visibleReady,
      activated,
      previousActiveAdapter,
    };
  }

  private async createSlot(
    adapter: DaemonAdapterKind,
    options: { profile?: string; sessionStartMode?: BridgeSessionStartMode },
  ): Promise<DaemonSlot> {
    clearLocalCompanionEndpoint(this.cwd, undefined, { adapter });
    const runtime = createRuntimeHost({
      kind: adapter,
      command: resolveDefaultAdapterCommand(adapter),
      cwd: this.cwd,
      profile: options.profile,
      lifecycle: "persistent",
      sessionStartMode: options.sessionStartMode,
      companionLaunchMode: "daemon_auto",
    });
    const controller = new BridgeController(runtime, this.cwd);
    const slot: DaemonSlot = {
      adapter,
      runtime,
      controller,
      outputBatcher: new OutputBatcher(async (text) => {
        await this.queueWechatMessage(
          this.authorizedUserId,
          prefixDaemonAdapterMessage(adapter, text),
        );
      }),
      pendingConfirmations: [],
      pendingUserInput: null,
      resumeCoordinator: new ResumeSessionCoordinator({
        adapter,
        runtime,
      }),
      activeTask: null,
      lastOutputAt: 0,
    };

    runtime.setEventSink((event) => {
      this.handleSlotEvent(slot, event);
    });
    await runtime.start();
    controller.syncLocalClientEndpoint();
    appendDaemonLog(
      `slot_started: adapter=${adapter} command=${resolveDefaultAdapterCommand(adapter)} cwd=${this.cwd} session_start_mode=${options.sessionStartMode ?? "restore"}`,
    );
    return slot;
  }

  private async startFreshSlotSession(slot: DaemonSlot): Promise<void> {
    await slot.outputBatcher.flushNow();
    slot.outputBatcher.clear();
    slot.pendingConfirmations = [];
    slot.pendingUserInput = null;
    slot.activeTask = null;

    if (slot.adapter === "codex" || slot.adapter === "claude") {
      await slot.runtime.reset();
    } else if (slot.adapter === "opencode" || slot.adapter === "pi") {
      if (!slot.runtime.createSession) {
        throw new Error(`/new is not available in ${slot.adapter} mode.`);
      }
      await slot.runtime.createSession();
    }

    slot.controller.syncLocalClientEndpoint();
  }

  private handleSlotEvent(slot: DaemonSlot, event: BridgeEvent): void {
    slot.controller.syncLocalClientEndpoint();
    const adapterState = slot.runtime.getState();
    if (slot.pendingConfirmations.length > 0 && !adapterState.pendingApproval) {
      slot.pendingConfirmations = [];
    }
    if (slot.pendingUserInput && !adapterState.pendingUserInput) {
      slot.pendingUserInput = null;
    }

    switch (event.type) {
      case "stdout":
      case "stderr":
        slot.lastOutputAt = Date.now();
        if (shouldForwardBridgeEventToWechat(slot.adapter, event.type)) {
          slot.outputBatcher.push(event.text);
        }
        break;
      case "final_reply":
        appendDaemonLog(`final_reply: adapter=${slot.adapter} text=${truncatePreview(event.text)}`);
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await forwardWechatFinalReply({
            adapter: slot.adapter,
            rawText: event.text,
            onEmptyVisibleReply: ({ rawVisibleText }) => {
              appendDaemonLog(
                `empty_visible_final_reply: adapter=${slot.adapter} raw=${truncatePreview(rawVisibleText)}`,
              );
            },
            sender: {
              sendText: async (text) => {
                const sent = await this.queueWechatMessage(
                  this.authorizedUserId,
                  prefixDaemonAdapterMessage(slot.adapter, text),
                  "final_reply",
                );
                if (sent) {
                  appendDaemonLog(
                    `final_reply_sent: adapter=${slot.adapter} chars=${Array.from(text).length}`,
                  );
                }
                return sent;
              },
              sendImage: (imagePath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendImage(imagePath, {
                    recipientId: this.authorizedUserId,
                  }),
                ),
              sendFile: (filePath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendFile(filePath, {
                    recipientId: this.authorizedUserId,
                  }),
                ),
              sendVoice: (voicePath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendVoice(voicePath, this.authorizedUserId),
                ),
              sendVideo: (videoPath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendVideo(videoPath, {
                    recipientId: this.authorizedUserId,
                  }),
                ),
            },
          });
        }));
        break;
      case "status":
        if (event.message) {
          log(`${slot.adapter} ${event.status}: ${event.message}`);
          appendDaemonLog(`${slot.adapter}_${event.status}: ${event.message}`);
        }
        break;
      case "notice":
        slot.lastOutputAt = Date.now();
        appendDaemonLog(`${slot.adapter}_${event.level}_notice: ${truncatePreview(event.text)}`);
        if (shouldForwardBridgeEventToWechat(slot.adapter, event.type, { text: event.text })) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              prefixDaemonAdapterMessage(slot.adapter, event.text),
              "notice",
            );
          }));
        }
        break;
      case "approval_required":
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          const pending = toPendingApproval(event);
          slot.pendingConfirmations.push(pending);
          appendDaemonLog(
            `approval_required: adapter=${slot.adapter} source=${pending.source} command=${truncatePreview(pending.commandPreview)}`,
          );
          await this.queueWechatMessage(
            this.authorizedUserId,
            prefixDaemonAdapterMessage(
              slot.adapter,
              formatApprovalMessage(pending, adapterState),
            ),
            "approval_required",
          );
        }));
        break;
      case "user_input_required": {
        // Mirror the pending request synchronously, before the async WeChat
        // send (which retries with backoff). Otherwise a fast user reply can
        // race past the still-unwritten mirror and be dispatched as plain
        // input into a CLI that is waiting for a structured form answer.
        const pending = toPendingUserInput(event.request);
        slot.pendingUserInput = pending;
        appendDaemonLog(
          `user_input_required: adapter=${slot.adapter} questions=${pending.questions.length}`,
        );
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await this.queueWechatMessage(
            this.authorizedUserId,
            prefixDaemonAdapterMessage(
              slot.adapter,
              formatUserInputRequestMessage(pending, adapterState),
            ),
            "user_input_required",
          );
        }));
        break;
      }
      case "mirrored_user_input":
        appendDaemonLog(
          `mirrored_local_input: adapter=${slot.adapter} text=${truncatePreview(event.text)}`,
        );
        if (shouldForwardBridgeEventToWechat(slot.adapter, event.type, { text: event.text })) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              prefixDaemonAdapterMessage(
                slot.adapter,
                formatMirroredUserInputMessage(slot.adapter, event.text),
              ),
              "mirrored_user_input",
            );
          }));
        }
        break;
      case "session_switched":
        appendDaemonLog(
          `session_switched: adapter=${slot.adapter} session=${event.sessionId} source=${event.source} reason=${event.reason}`,
        );
        if (
          shouldForwardSessionSwitchEvent(event.reason) &&
          shouldForwardBridgeEventToWechat(slot.adapter, event.type)
        ) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              prefixDaemonAdapterMessage(
                slot.adapter,
                formatSessionSwitchMessage({
                  adapter: slot.adapter,
                  sessionId: event.sessionId,
                  source: event.source,
                  reason: event.reason,
                }),
              ),
              "session_switched",
            );
          }));
        }
        break;
      case "thread_switched":
        appendDaemonLog(
          `thread_switched: adapter=${slot.adapter} thread=${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        if (
          shouldForwardSessionSwitchEvent(event.reason) &&
          shouldForwardBridgeEventToWechat(slot.adapter, event.type)
        ) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              prefixDaemonAdapterMessage(
                slot.adapter,
                formatSessionSwitchMessage({
                  adapter: slot.adapter,
                  sessionId: event.threadId,
                  source: event.source,
                  reason: event.reason,
                }),
              ),
              "thread_switched",
            );
          }));
        }
        break;
      case "task_complete":
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(() => {
          slot.pendingConfirmations = [];
          slot.pendingUserInput = null;
          slot.activeTask = null;
        }));
        break;
      case "task_failed":
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          slot.pendingConfirmations = [];
          slot.pendingUserInput = null;
          slot.activeTask = null;
          await this.queueWechatMessage(
            this.authorizedUserId,
            prefixDaemonAdapterMessage(
              slot.adapter,
              formatTaskFailedMessage(slot.adapter, event.message),
            ),
            "task_failed",
          );
        }));
        break;
      case "fatal_error":
        logError(`${slot.adapter}: ${event.message}`);
        appendDaemonLog(`fatal_error: adapter=${slot.adapter} message=${event.message}`);
        slot.pendingConfirmations = [];
        slot.pendingUserInput = null;
        slot.activeTask = null;
        this.disposeDeadSlot(slot);
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await this.queueWechatMessage(
            this.authorizedUserId,
            prefixDaemonAdapterMessage(
              slot.adapter,
              formatUserFacingBridgeFatalError(event.message),
            ),
            "fatal_error",
          );
        }));
        break;
      case "shutdown_requested":
        appendDaemonLog(
          `slot_shutdown_requested: adapter=${slot.adapter} reason=${event.reason}`,
        );
        break;
    }
  }

  private async handleInboundMessage(message: InboundWechatMessage): Promise<void> {
    if (message.senderId !== this.authorizedUserId) {
      await this.queueWechatMessage(
        message.senderId,
        "Unauthorized. This daemon only accepts messages from the configured WeChat owner.",
      );
      return;
    }

    const emojiMatch = resolveEmojiCommand(message.text);
    if (emojiMatch) {
      const switchTarget = parseDaemonSwitchCommand(emojiMatch.command);
      if (switchTarget && emojiMatch.remainder) {
        const result = await this.ensureSlot(switchTarget, {
          openVisible: true,
          reuseExistingVisible: true,
        });
        if (result.activated) {
          message = { ...message, text: emojiMatch.remainder };
        } else {
          const detail = formatDaemonSwitchResultDetail(result);
          await this.queueWechatMessage(
            message.senderId,
            `Could not activate terminal: ${switchTarget}.\n${detail}`,
          );
          return;
        }
      } else {
        const rewritten = emojiMatch.remainder
          ? `${emojiMatch.command} ${emojiMatch.remainder}`
          : emojiMatch.command;
        message = { ...message, text: rewritten };
      }
    }

    const switchDirective = parseDaemonSwitchDirective(message.text);
    if (switchDirective) {
      const result = await this.ensureSlot(switchDirective.adapter, {
        openVisible: true,
        reuseExistingVisible: true,
      });
      const detail = formatDaemonSwitchResultDetail(result);
      if (!result.activated) {
        await this.queueWechatMessage(
          message.senderId,
          `Could not activate terminal: ${switchDirective.adapter}.\n${detail}`,
        );
        return;
      }
      if (switchDirective.remainder) {
        message = { ...message, text: switchDirective.remainder };
      } else {
        await this.queueWechatMessage(
          message.senderId,
          `Active terminal: ${switchDirective.adapter}.\n${detail}`,
        );
        return;
      }
    }

    if (message.text.trim().toLowerCase() === "/daemon-stop") {
      await this.queueWechatMessage(message.senderId, "Stopping wechat-daemon...");
      setTimeout(() => {
        void this.shutdown().finally(() => process.exit(0));
      }, 0);
      return;
    }

    const bindingsCmd = parseEmojiBindingsCommand(message.text);
    if (bindingsCmd) {
      await this.handleEmojiBindingsCommand(message.senderId, bindingsCmd);
      return;
    }

    if (isBindCommandPrefix(message.text)) {
      await this.queueWechatMessage(message.senderId, formatBindCommandUsage());
      return;
    }

    let slot = this.getActiveSlot();
    if (!slot) {
      await this.queueWechatMessage(message.senderId, formatNoActiveAdapterMessage());
      return;
    }

    const command = parseWechatControlCommand(message.text, {
      adapter: slot.adapter,
      hasPendingConfirmation: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
    });

    if (command) {
      await this.handleSystemCommand(message, slot, command);
      return;
    }

    if (slot.pendingConfirmations.length > 0) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          formatPendingApprovalReminder(
            slot.pendingConfirmations[0]!,
            slot.runtime.getState(),
          ),
        ),
      );
      return;
    }

    if (slot.pendingUserInput) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          formatPendingUserInputReminder(slot.pendingUserInput),
        ),
      );
      return;
    }

    const visibleResult = await this.ensureSlot(slot.adapter, {
      openVisible: true,
      reuseExistingVisible: true,
    });
    if (!visibleResult.activated) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          formatDaemonSwitchResultDetail(visibleResult),
        ),
      );
      return;
    }
    slot = this.getActiveSlot() ?? slot;

    const adapterState = slot.runtime.getState();
    if (adapterState.status === "awaiting_input") {
      // Belt-and-braces with the pendingUserInput mirror above: the adapter
      // state is authoritative even when the mirror was cleared or the WeChat
      // notification is still queued.
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          slot.pendingUserInput
            ? formatPendingUserInputReminder(slot.pendingUserInput)
            : `${slot.adapter} is waiting for structured input. Reply with /answer <key>=<value> ...`,
        ),
      );
      return;
    }
    if (adapterState.status === "busy" || adapterState.status === "awaiting_approval") {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          `${slot.adapter} is still working. Wait for the current reply or use /stop.`,
        ),
      );
      return;
    }

    await this.dispatchInboundWechatText(message, slot);
  }

  private async handleEmojiBindingsCommand(
    senderId: string,
    cmd: EmojiBindingsCommand,
  ): Promise<void> {
    switch (cmd.type) {
      case "list": {
        await this.queueWechatMessage(senderId, formatBindingsListMessage(listBindings()));
        return;
      }
      case "bind": {
        setBinding(cmd.emoji, cmd.command);
        await this.queueWechatMessage(
          senderId,
          `Bound ${cmd.emoji} → ${cmd.command}`,
        );
        return;
      }
      case "unbind": {
        const removed = removeBinding(cmd.emoji);
        await this.queueWechatMessage(
          senderId,
          removed
            ? `Unbound ${cmd.emoji}`
            : `No binding found for ${cmd.emoji}`,
        );
        return;
      }
    }
  }

  private async handleSystemCommand(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    command: NonNullable<ReturnType<typeof parseWechatControlCommand>>,
  ): Promise<void> {
    switch (command.type) {
      case "status":
        await this.queueWechatMessage(
          message.senderId,
          formatDaemonStatus(this.getStatus()),
        );
        return;
      case "resume": {
        if (!isWechatResumeEnabled(activeSlot.adapter)) {
          await this.queueWechatMessage(
            message.senderId,
            `WeChat /resume is disabled for ${activeSlot.adapter} in daemon mode. Use /resume directly inside the visible terminal; WeChat will follow that local session.`,
          );
          return;
        }
        try {
          if (command.target) {
            await activeSlot.outputBatcher.flushNow();
          }
          const result = await activeSlot.resumeCoordinator.execute(command.target);
          if (result.kind === "resumed") {
            activeSlot.activeTask = null;
          }
          await this.queueWechatMessage(
            message.senderId,
            prefixDaemonAdapterMessage(activeSlot.adapter, result.message),
          );
        } catch (error) {
          await this.queueWechatMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              activeSlot.adapter,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        return;
      }
      case "new_session":
        if (!activeSlot.runtime.createSession) {
          await this.queueWechatMessage(
            message.senderId,
            `/new is not available in ${activeSlot.adapter} mode.`,
          );
          return;
        }
        await activeSlot.outputBatcher.flushNow();
        activeSlot.outputBatcher.clear();
        activeSlot.pendingConfirmations = [];
        activeSlot.pendingUserInput = null;
        activeSlot.resumeCoordinator.clear();
        await activeSlot.runtime.createSession();
        appendDaemonLog(`new_session: adapter=${activeSlot.adapter}`);
        return;
      case "stop": {
        const interrupted = await activeSlot.runtime.interrupt();
        await this.queueWechatMessage(
          message.senderId,
          prefixDaemonAdapterMessage(
            activeSlot.adapter,
            interrupted
              ? "Interrupt signal sent to the active worker."
              : "No running worker was available to interrupt.",
          ),
        );
        return;
      }
      case "reset":
        await activeSlot.outputBatcher.flushNow();
        activeSlot.outputBatcher.clear();
        activeSlot.pendingConfirmations = [];
        activeSlot.pendingUserInput = null;
        activeSlot.resumeCoordinator.clear();
        await activeSlot.runtime.reset();
        appendDaemonLog(`reset: adapter=${activeSlot.adapter}`);
        await this.queueWechatMessage(
          message.senderId,
          prefixDaemonAdapterMessage(activeSlot.adapter, "Worker session has been reset."),
        );
        return;
      case "confirm":
        await this.confirmPendingApproval(message, activeSlot);
        return;
      case "deny":
        await this.denyPendingApproval(message, activeSlot);
        return;
      case "answer":
        await this.answerPendingUserInput(message, activeSlot, command.raw);
        return;
    }
  }

  private async confirmPendingApproval(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
  ): Promise<void> {
    const slot = this.resolvePendingApprovalSlot(activeSlot);
    if (!slot || slot.pendingConfirmations.length === 0) {
      await this.queueWechatMessage(message.senderId, "No pending approval request.");
      return;
    }

    const count = await slot.runtime.resolveAllApprovals("confirm");
    if (!count) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          "The worker could not apply this approval request.",
        ),
      );
      return;
    }
    const preview = slot.pendingConfirmations[0]?.commandPreview ?? "";
    slot.pendingConfirmations = [];
    slot.activeTask = {
      startedAt: Date.now(),
      inputPreview: preview,
    };
    appendDaemonLog(
      `approval_confirmed: adapter=${slot.adapter} count=${count} command=${truncatePreview(preview)}`,
    );
    await this.queueWechatMessage(
      message.senderId,
      prefixDaemonAdapterMessage(
        slot.adapter,
        count > 1
          ? `${count} approvals confirmed. Continuing...`
          : "Approval confirmed. Continuing...",
      ),
    );
  }

  private async denyPendingApproval(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
  ): Promise<void> {
    const slot = this.resolvePendingApprovalSlot(activeSlot);
    if (!slot || slot.pendingConfirmations.length === 0) {
      await this.queueWechatMessage(message.senderId, "No pending approval request.");
      return;
    }

    const count = await slot.runtime.resolveAllApprovals("deny");
    if (!count) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          "The worker could not deny this approval request cleanly.",
        ),
      );
      return;
    }
    slot.pendingConfirmations = [];
    appendDaemonLog(
      `approval_denied: adapter=${slot.adapter} count=${count}`,
    );
    await this.queueWechatMessage(
      message.senderId,
      prefixDaemonAdapterMessage(
        slot.adapter,
        count > 1 ? `${count} approvals denied.` : "Approval denied.",
      ),
    );
  }

  private async answerPendingUserInput(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    raw: string,
  ): Promise<void> {
    // Mirror the /confirm and /deny behavior: search every slot for a pending
    // user-input request so the answer reaches the adapter that asked, even
    // when the user has since switched the active adapter.
    const slot = this.resolvePendingUserInputSlot(activeSlot);
    if (!slot) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(activeSlot.adapter, "No pending user input request."),
      );
      return;
    }

    const pending = slot.pendingUserInput;
    if (!pending) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(activeSlot.adapter, "No pending user input request."),
      );
      return;
    }

    const parsed = parsePendingUserInputAnswerCommand(raw, pending);
    if ("error" in parsed) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(slot.adapter, parsed.error),
      );
      return;
    }

    const submitted = await slot.runtime.submitUserInput(parsed.answers);
    if (!submitted) {
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          "The worker could not apply this answer.",
        ),
      );
      return;
    }

    slot.pendingUserInput = null;
    slot.activeTask = {
      startedAt: Date.now(),
      inputPreview: parsed.preview,
    };
    appendDaemonLog(
      `user_input_answered: adapter=${slot.adapter} preview=${parsed.preview}`,
    );
    await this.queueWechatMessage(
      message.senderId,
      prefixDaemonAdapterMessage(slot.adapter, "Answer submitted. Continuing..."),
    );
  }

  private resolvePendingUserInputSlot(
    activeSlot: DaemonSlot,
  ): DaemonSlot | null {
    if (activeSlot.pendingUserInput) {
      return activeSlot;
    }

    return (
      Array.from(this.slots.values()).find(
        (slot) => slot.pendingUserInput !== null,
      ) ?? null
    );
  }

  private resolvePendingApprovalSlot(
    activeSlot: DaemonSlot,
  ): DaemonSlot | null {
    if (activeSlot.pendingConfirmations.length > 0) {
      return activeSlot;
    }

    return (
      Array.from(this.slots.values()).find(
        (slot) => slot.pendingConfirmations.length > 0,
      ) ?? null
    );
  }

  private getActiveSlot(): DaemonSlot | null {
    if (!this.activeAdapter) {
      return null;
    }
    return this.slots.get(this.activeAdapter) ?? null;
  }

  private async dispatchInboundWechatText(
    message: InboundWechatMessage,
    slot: DaemonSlot,
  ): Promise<void> {
    const preview = formatInboundMessagePreview(message);
    slot.activeTask = {
      startedAt: Date.now(),
      inputPreview: truncatePreview(preview, 180),
    };
    appendDaemonLog(
      `forwarded_input: adapter=${slot.adapter} text=${truncatePreview(preview)}`,
    );
    await slot.runtime.sendInput(
      buildWechatInboundPrompt(message.text, message.attachments),
    );
  }

  private queueWechatTextAction<T>(action: () => Promise<T>): Promise<T> {
    const run = this.textSendChain.then(action);
    this.textSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private queueWechatAttachmentAction<T>(action: () => Promise<T>): Promise<T> {
    const run = this.attachmentSendChain.then(action);
    this.attachmentSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private queueWechatMessage(
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ): Promise<boolean> {
    return this.queueWechatTextAction(async () => {
      for (let attempt = 1; attempt <= WECHAT_SEND_MAX_ATTEMPTS; attempt += 1) {
        try {
          await this.transport.sendText(senderId, text);
          return true;
        } catch (error) {
          if (isWechatContextTokenStaleError(error)) {
            this.transport.clearCachedContextToken(senderId);
            appendDaemonLog(
              formatWechatContextTokenStaleLogEntry({
                context,
                recipientId: senderId,
                error,
              }),
            );
            return false;
          }

          if (attempt < WECHAT_SEND_MAX_ATTEMPTS && isRetryableWechatSendError(error)) {
            const delayMs = computeWechatSendRetryDelayMs(attempt);
            appendDaemonLog(
              `wechat_send_retry: context=${context} recipient=${senderId} attempt=${attempt} delay_ms=${delayMs} error=${truncatePreview(describeWechatTransportError(error), 400)}`,
            );
            await delay(delayMs);
            continue;
          }

          logError(`Failed to send WeChat ${context}: ${describeWechatTransportError(error)}`);
          appendDaemonLog(
            formatWechatSendFailureLogEntry({
              context,
              recipientId: senderId,
              error,
            }),
          );
          return false;
        }
      }

      return false;
    });
  }

  private trackWechatForwardTask(task: Promise<void>): void {
    const tracked = task
      .catch((error) => {
        logError(`WeChat forward task failed: ${describeWechatTransportError(error)}`);
        appendDaemonLog(
          `wechat_forward_failed: error=${truncatePreview(describeWechatTransportError(error), 400)}`,
        );
      })
      .finally(() => {
        this.pendingWechatForwardTasks.delete(tracked);
      });
    this.pendingWechatForwardTasks.add(tracked);
  }

  private async waitForPendingWechatForwardTasks(): Promise<void> {
    while (this.pendingWechatForwardTasks.size > 0) {
      await Promise.allSettled([...this.pendingWechatForwardTasks]);
    }
  }
}

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

export async function cleanupDaemonBeforeStart(
  deps: DaemonCleanupDeps = {},
): Promise<DaemonCleanupResult> {
  const readEndpoint = deps.readEndpoint ?? readDaemonEndpoint;
  const isAlive = deps.isAlive ?? isPidAlive;
  const sendRequest = deps.sendRequest ?? sendDaemonRequest;
  const killProcess = deps.killProcess ?? killProcessTreeSync;
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

export async function runDaemon(
  options: DaemonCliOptions,
): Promise<void> {
  migrateLegacyChannelFiles((message) => log(message));
  loadEmojiBindings();
  await cleanupDaemonBeforeStart({ cwd: options.cwd });
  const cleanupResult = await cleanupSingleBridgeBeforeDaemon();
  const reapedPeerPids = await reapPeerBridgeProcesses({
    logger: (message) => appendDaemonLog(message),
  });
  if (reapedPeerPids.length > 0) {
    log(`Cleaned ${reapedPeerPids.length} peer bridge process(es): ${reapedPeerPids.join(", ")}`);
  }
  const reapedOpencodePids = await reapOrphanedOpencodeProcesses({
    logger: (message) => appendDaemonLog(message),
  });
  if (reapedOpencodePids.length > 0) {
    log(`Cleaned ${reapedOpencodePids.length} orphaned OpenCode process(es): ${reapedOpencodePids.join(", ")}`);
  }
  const credentials = await ensureWechatCredentials({
    requireUserId: true,
    validateExisting: true,
    log,
  });
  if (!credentials.userId) {
    throw new Error("Saved WeChat credentials are missing userId.");
  }

  const daemon = new WechatDaemon({
    cwd: options.cwd,
    profile: options.profile,
    authorizedUserId: credentials.userId,
    transport: new WeChatTransport({ log, logError }),
  });
  if (cleanupResult.action === "stopped" && isDaemonAdapterKind(cleanupResult.lock.adapter)) {
    daemon.takenOverAdapter = cleanupResult.lock.adapter;
  }
  await daemon.startIpcServer();
  try {
    await daemon.runInitialAdapter(options);

    let shutdownInProgress = false;
    const handleSignal = (signal: string) => {
      if (shutdownInProgress) {
        log(`Received ${signal} during shutdown, forcing exit.`);
        process.exit(1);
      }
      shutdownInProgress = true;
      log(`Received ${signal}. Stopping daemon.`);
      void daemon.shutdown().finally(() => process.exit(0));
    };
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGHUP", () => handleSignal("SIGHUP"));
    if (process.platform === "win32") {
      process.on("SIGBREAK", () => handleSignal("SIGBREAK"));
    }
    process.on("exit", () => {
      clearDaemonEndpoint();
    });

    await daemon.runPollLoop();
  } catch (error) {
    // Abnormal exit (poll loop failure, initial adapter failure): dispose the
    // slot runtimes so adapter child processes are not stranded as orphans.
    await daemon.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck(argv, { mode: "daemon" });
    process.exit(0);
  }
  try {
    await runDaemon(parseDaemonCliArgs(argv));
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  void main();
}
