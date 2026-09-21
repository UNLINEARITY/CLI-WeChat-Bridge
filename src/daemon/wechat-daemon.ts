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
  type WechatInboundPromptAttachment,
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
  WECHAT_SEND_CONTEXTS,
  formatUserFacingBridgeFatalError,
  formatUserFacingInboundError,
  isWechatSendContext,
  shouldForwardBridgeEventToWechat,
  shouldSuppressCodexLocalThreadNotice,
  type WechatSendContext,
} from "../channels/wechat/wechat-forwarding.ts";
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
  WeChatTransport,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  getPendingChannelMessagesFile,
  getPendingWechatMessagesFile,
  PendingWechatMessageStore,
} from "../channels/wechat/wechat-outbound-queue.ts";
import {
  createRuntimeHost,
} from "../runtime/create-runtime-host.ts";
import { toChannelInboundMessage } from "../channels/wechat/channel-message.ts";
import { routeBridgeMessage } from "../core/bridge-message-router.ts";
import {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  isRetryableDeferredCodexDrainError,
  shouldDeferCodexInboundMessage,
} from "../core/bridge-defer.ts";
import { InboundConversationContext } from "../core/conversation-routing.ts";
import { TurnCoordinator, type TurnDispatchResult } from "../core/turn-coordinator.ts";
import { resolveDaemonOutboundTarget } from "../core/outbound-target.ts";
import { handleAdapterControl, invalidateModelSnapshot } from "../bridge/adapter-control.ts";
import { forwardBridgeEvent } from "../core/bridge-event-forwarder.ts";
import { isDirectModuleRun } from "../core/direct-run.ts";
import { WechatChannelPort } from "../channels/wechat/wechat-channel-port.ts";
import { ensureWecomAccount } from "../channels/wecom/setup.ts";
import { WecomChannelPort } from "../channels/wecom/wecom-channel-port.ts";
import { WecomTransport } from "../channels/wecom/wecom-transport.ts";
import { WecomChannelDriver } from "../channels/wecom/wecom-driver.ts";
import { WechatChannelDriver } from "../channels/wechat/wechat-driver.ts";
import type {
  ChannelDriver,
  ChannelSendResult,
} from "../core/channel-driver.ts";
import type {
  BridgeChannelId,
  BridgeChannelPort,
  ChannelConversationRef,
  ChannelInboundMessage,
  ChannelOutputKind,
} from "../core/channel-types.ts";
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
  type DaemonForwardInputResult,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSendTextResult,
  type DaemonSlotSummary,
  type DaemonStatus,
} from "./daemon-link.ts";

type DaemonCliOptions = {
  cwd: string;
  profile?: string;
  initialAdapter?: DaemonAdapterKind;
  openVisible: boolean;
  channelId?: BridgeChannelId;
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
  turns: TurnCoordinator<ActiveTask>;
  lastOutputAt: number;
  lastFinalReplyAtMs: number;
  eventForwardChain: Promise<void>;
  deferredInputs: DeferredDaemonInput[];
  drainingDeferredInputs: boolean;
};

type DeferredDaemonInput = {
  message: InboundWechatMessage;
  conversation?: ChannelConversationRef;
};

export type WechatDaemonDeps = {
  createRuntime?: typeof createRuntimeHost;
  openVisibleClient?: typeof openVisibleClient;
  isVisibleClientAlive?: typeof isVisibleClientAlive;
  daemonLog?: (message: string) => void;
  pendingWechatMessages?: PendingWechatMessageStore;
  visibleClientConnectTimeoutMs?: number;
};

type WechatSendResult = ChannelSendResult;

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
const MAX_DAEMON_DEFERRED_INPUTS = 32;
const DAEMON_ADAPTERS: DaemonAdapterKind[] = ["codex", "claude", "opencode", "pi"];

function getCliChannelId(argv: string[] = process.argv.slice(2)): BridgeChannelId {
  const index = argv.indexOf("--channel");
  return index >= 0 && argv[index + 1] === "wecom" ? "wecom" : "wechat";
}

function log(message: string): void {
  process.stderr.write(`[${getCliChannelId()}-daemon] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[${getCliChannelId()}-daemon] ERROR: ${message}\n`);
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

function toWechatSendContext(kind: ChannelOutputKind): WechatSendContext {
  if (kind === "mirrored_input") {
    return "mirrored_user_input";
  }
  if (kind === "status") {
    return "message";
  }
  return kind;
}

function toLegacyInboundWechatMessage(
  message: ChannelInboundMessage,
): InboundWechatMessage {
  return {
    senderId: message.senderId,
    sender: message.senderId,
    sessionId: message.conversation.conversationId,
    text: message.text,
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind === "image" ? "image" : "file",
      path: attachment.path,
      fileName: attachment.fileName || path.basename(attachment.path),
      sizeBytes: attachment.sizeBytes ?? 0,
    })),
    contextToken: message.conversation.opaqueRef,
    createdAt: message.createdAt,
    createdAtMs: Date.parse(message.createdAt),
  };
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
  let channelId: BridgeChannelId = "wechat";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          `Usage: ${channelId}-daemon [--cwd <path>] [--adapter <codex|claude|opencode|pi>] [--profile <name-or-path>] [--no-open]`,
          "",
          `Keeps one ${channelId === "wecom" ? "WeCom" : "WeChat"} connection alive and switches between Codex, Claude Code, OpenCode, and Pi.`,
          `Send /codex, /claude, /opencode, or /pi in ${channelId === "wecom" ? "WeCom" : "WeChat"} to switch the active terminal.`,
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
      if (!next || (next !== "wechat" && next !== "wecom")) {
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
    ...(channelId === "wecom" ? { channelId } : {}),
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
  channelId?: BridgeChannelId;
}): string {
  return [
    "start",
    quoteWindowsCommandArg(`${params.channelId ?? "wechat"}-${params.adapter}`),
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

function formatLaunchPreview(launch: VisibleClientLaunch): string {
  return [launch.command, ...launch.args].join(" ");
}

function openVisibleClient(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs?: string[];
  onError?: (error: Error) => void;
  channelId?: BridgeChannelId;
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
        channelId: params.channelId,
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

  const title = `${params.channelId ?? "wechat"}-${params.adapter}`;
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

export class WechatDaemon {
  private readonly cwd: string;
  private readonly profile?: string;
  private readonly authorizedUserId: string;
  private readonly transport: WeChatTransport;
  private readonly channelDriver: ChannelDriver;
  private readonly channelId: BridgeChannelId;
  private readonly wecomTransport: WecomTransport | null;
  private readonly inboundConversationContext =
    new InboundConversationContext();
  private readonly fallbackConversation: ChannelConversationRef;
  private readonly slots = new Map<DaemonAdapterKind, DaemonSlot>();
  // Per-adapter serialization chains for ensureSlot (see ensureSlot comment).
  private readonly slotEnsureChains = new Map<DaemonAdapterKind, Promise<unknown>>();
  private readonly startedAt = new Date().toISOString();
  private readonly bridgeStartedAtMs = Date.now();
  private backlogNoticeSent = false;
  private activeAdapter: DaemonAdapterKind | null = null;
  private activeAdapterVersion = 0;
  takenOverAdapter?: DaemonAdapterKind;
  private textSendChain = Promise.resolve();
  private attachmentSendChain = Promise.resolve();
  private readonly pendingWechatForwardTasks = new Set<Promise<void>>();
  private readonly slotInputChains = new Map<DaemonAdapterKind, Promise<unknown>>();
  private readonly pendingWechatMessages: PendingWechatMessageStore;
  private readonly deps: WechatDaemonDeps;
  private shutdownPromise: Promise<void> | null = null;
  private ipcServer: net.Server | null = null;
  private endpointToken = "";

  constructor(params: {
    cwd: string;
    profile?: string;
    authorizedUserId: string;
    transport: WeChatTransport;
    channelId?: BridgeChannelId;
    accountId?: string;
    wecomTransport?: WecomTransport | null;
    deps?: WechatDaemonDeps;
  }) {
    this.cwd = params.cwd;
    this.profile = params.profile;
    this.authorizedUserId = params.authorizedUserId;
    this.transport = params.transport;
    this.channelId = params.channelId ?? "wechat";
    this.wecomTransport = params.wecomTransport ?? null;
    this.deps = params.deps ?? {};
    this.channelDriver = this.wecomTransport
      ? new WecomChannelDriver({
          transport: this.wecomTransport,
          accountId: params.accountId,
          operatorId: params.authorizedUserId,
          logError,
        })
      : new WechatChannelDriver({
          transport: this.transport,
          logError,
          buildInboundPrompt: (text, attachments) =>
            buildWechatInboundPrompt(
              text,
              attachments.filter((attachment): attachment is WechatInboundPromptAttachment =>
                attachment.kind === "image" || attachment.kind === "file"),
            ),
        });
    this.fallbackConversation = this.channelDriver.defaultConversation()
      ?? this.channelDriver.directConversation(params.authorizedUserId);
    this.pendingWechatMessages = this.deps.pendingWechatMessages ??
      new PendingWechatMessageStore(
        this.channelId === "wechat"
          ? getPendingWechatMessagesFile(this.cwd)
          : getPendingChannelMessagesFile(this.cwd, this.channelId),
      );
  }

  private daemonLog(message: string): void {
    (this.deps.daemonLog ?? appendDaemonLog)(message);
  }

  private createRuntime(options: Parameters<typeof createRuntimeHost>[0]): BridgeAdapter {
    return (this.deps.createRuntime ?? createRuntimeHost)(options);
  }

  private isVisibleClientAlive(cwd: string, adapter: DaemonAdapterKind): boolean {
    return (this.deps.isVisibleClientAlive ?? isVisibleClientAlive)(cwd, adapter);
  }

  private openVisibleClient(options: Parameters<typeof openVisibleClient>[0]): VisibleClientLaunch {
    return (this.deps.openVisibleClient ?? openVisibleClient)(options);
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
          channelId: this.channelId,
        });
        resolve();
      });
    });
  }

  getStatus(): DaemonStatus {
    return {
      cwd: this.cwd,
      channelId: this.channelId,
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
    if (this.channelDriver.start) {
      await this.channelDriver.start({
        onInboundMessage: async (channelMessage) => {
          if (this.shutdownPromise) {
            return;
          }
          await this.inboundConversationContext.run(
            channelMessage.conversation,
            async () => {
              if (this.pendingWechatMessages.list().length > 0) {
                await this.flushPendingWechatMessages();
              }
              await this.handleInboundMessage(
                toLegacyInboundWechatMessage(channelMessage),
              );
            },
          );
        },
        onUnauthorizedSender: async (senderId, chatType) => {
          appendDaemonLog(
            `wecom_unauthorized: sender=${senderId} chat_type=${chatType}`,
          );
          if (chatType === "direct") {
            const result = await this.channelDriver.sendText({
              target: this.channelDriver.directConversation(senderId),
              text: "Unauthorized.",
              context: "notice",
              log: appendDaemonLog,
            });
            if (result.status !== "sent") {
              logError(`Failed to reply unauthorized notice to ${senderId}`);
            }
          }
        },
        onChannelFatal: async (error: Error) => {
          appendDaemonLog(`wecom_fatal_error: ${error.message}`);
          await this.shutdown();
        },
        onChannelConnected: async () => {
          if (this.pendingWechatMessages.list().length > 0) {
            await this.flushPendingWechatMessages();
          }
        },
      });
      await this.channelDriver.waitUntilReady?.();
    }

    log(`${this.channelDriver.displayName} daemon is ready.`);
    log(`Working directory: ${this.cwd}`);
    log(
      `Switch from ${this.channelDriver.displayName} with /codex, /claude, /opencode, or /pi.`,
    );
    appendDaemonLog(`started: channel=${this.channelId} cwd=${this.cwd}`);

    const activeSlot = this.getActiveSlot();
    const welcomeText = t("daemon.welcome", {
      cwd: this.cwd,
      adapter: activeSlot?.adapter ?? "none",
      bindings: formatBindingsListMessage(listBindings()),
    });
    await this.queueWechatMessage(this.authorizedUserId, welcomeText);

    if (this.channelDriver.capabilities.pushInbound) {
      while (!this.shutdownPromise) {
        await delay(1_000);
      }
      await this.shutdownPromise;
      return;
    }

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

      if (pollResult.messages.length > 0 && this.pendingWechatMessages.list().length > 0) {
        await this.flushPendingWechatMessages();
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
    // Stop accepting new channel work and abort an in-flight long poll before
    // waiting for queued sends or adapter disposal. Otherwise Ctrl+C can leave
    // the process alive until the 35-second poll timeout and retain the daemon
    // endpoint for the next startup to clean up.
    try {
      this.transport.stop();
    } catch {
      // Best effort shutdown.
    }
    try {
      this.wecomTransport?.stop();
    } catch {
      // Best effort shutdown.
    }
    clearDaemonEndpoint();

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

  async handleDaemonRequest(request: DaemonRequest): Promise<unknown> {
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
            `${this.channelId}-daemon is bound to ${this.cwd}; requested cwd was ${request.cwd}.`,
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
      case "send_text":
        return await this.handleDaemonSendText(request);
      case "forward_input":
        return await this.handleDaemonForwardInput(request);
    }
  }

  async handleDaemonSendText(
    request: Extract<DaemonRequest, { command: "send_text" }>,
  ): Promise<DaemonSendTextResult> {
    if (!request.text.trim()) {
      throw new Error("send_text requires non-empty text.");
    }
    if (request.channel && request.channel !== this.channelId) {
      throw new Error(`${this.channelId}-daemon cannot send to ${request.channel}.`);
    }
    const context = request.context ?? "message";
    if (!isWechatSendContext(context)) {
      throw new Error(
        `Invalid send_text context: ${JSON.stringify(request.context)}. Valid contexts: ${WECHAT_SEND_CONTEXTS.join(", ")}.`,
      );
    }
    const target = this.channelDriver.capabilities.multiConversation
      ? {
          ...this.channelDriver.directConversation(request.recipientId),
          ...(request.conversationId && request.conversationId !== request.recipientId
            ? { conversationId: request.conversationId }
            : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        }
      : undefined;
    const sent = await this.queueWechatMessage(
      request.recipientId,
      request.text,
      context,
      target,
    );
    return {
      sent,
      recipientId: request.recipientId,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
    };
  }

  getSlotState(adapter: DaemonAdapterKind): {
    active: boolean;
    hasActiveTask: boolean;
    activeConversationId?: string;
    lastConversationId?: string;
  } | null {
    const slot = this.slots.get(adapter);
    if (!slot) return null;
    return {
      active: this.activeAdapter === adapter,
      hasActiveTask: slot.turns.hasActiveTask,
      ...(slot.turns.activeConversation?.conversationId
        ? { activeConversationId: slot.turns.activeConversation.conversationId }
        : {}),
      ...(slot.turns.lastConversation?.conversationId
        ? { lastConversationId: slot.turns.lastConversation.conversationId }
        : {}),
    };
  }

  async handleDaemonForwardInput(
    request: Extract<DaemonRequest, { command: "forward_input" }>,
  ): Promise<DaemonForwardInputResult> {
    if (!request.text.trim()) {
      throw new Error("forward_input requires non-empty text.");
    }
    if (request.cwd && !isSameWorkspaceCwd(request.cwd, this.cwd)) {
      throw new Error(
        `${this.channelId}-daemon is bound to ${this.cwd}; requested cwd was ${request.cwd}.`,
      );
    }

    const adapter = request.adapter ?? this.activeAdapter;
    if (!adapter) {
      throw new Error("No active adapter slot is available.");
    }
    const senderId = request.senderId ?? this.authorizedUserId;
    const conversationId = request.conversationId ?? senderId;
    const conversation: ChannelConversationRef = {
      channelId: this.channelId,
      conversationId,
      recipientId: request.recipientId ?? senderId,
      ...(request.contextToken ? { opaqueRef: request.contextToken } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    const previousActiveAdapter = this.activeAdapter;
    const ensureResult = await this.ensureSlot(adapter, {
      openVisible: true,
      reuseExistingVisible: true,
    });
    if (!ensureResult.activated) {
      return {
        forwarded: false,
        adapter,
        conversationId,
        reason: "not_activated",
        message: formatDaemonSwitchResultDetail(ensureResult),
      };
    }
    const slot = this.slots.get(adapter);
    if (!slot) {
      throw new Error(`Adapter slot ${adapter} is not available.`);
    }

    const inboundMessage: InboundWechatMessage = {
      senderId,
      sender: senderId,
      sessionId: conversationId,
      text: request.text,
      attachments: [],
      contextToken: request.contextToken,
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    };

    try {
      const routed = await this.serializeSlotInput(slot, () =>
        this.inboundConversationContext.run(conversation, () =>
          this.routeDaemonInput(slot, inboundMessage, conversation),
        ));
      if (routed.kind === "dispatched") {
        return { forwarded: true, adapter, conversationId };
      }
      this.restoreActiveAdapterAfterRejectedInput(
        adapter,
        ensureResult.activationVersion,
        previousActiveAdapter,
      );
      return {
        forwarded: false,
        ...(routed.queued ? { queued: true } : {}),
        ...(routed.queuePosition !== undefined ? { queuePosition: routed.queuePosition } : {}),
        adapter,
        conversationId,
        reason: routed.reason,
        message: routed.message,
      };
    } catch (error) {
      this.restoreActiveAdapterAfterRejectedInput(
        adapter,
        ensureResult.activationVersion,
        previousActiveAdapter,
      );
      throw error;
    }
  }

  private async routeDaemonInput(
    slot: DaemonSlot,
    inboundMessage: InboundWechatMessage,
    conversation: ChannelConversationRef,
  ): Promise<{
    kind: "dispatched" | "deferred" | "handled";
    reason?: DaemonForwardInputResult["reason"];
    message?: string;
    queued?: boolean;
    queuePosition?: number;
  }> {
    const runtimeState = slot.runtime.getState();
    const adapterState = slot.turns.hasActiveTask && runtimeState.status === "idle"
      ? { ...runtimeState, status: "busy" as const }
      : runtimeState;
    let reason: DaemonForwardInputResult["reason"];
    let routeMessage: string | undefined;
    let queued = false;
    let queuePosition: number | undefined;
    const sendReminder = (text: string, context: WechatSendContext) =>
      this.queueWechatMessage(inboundMessage.senderId, text, context, conversation);

    const routeResult = await routeBridgeMessage({
      message: toChannelInboundMessage(inboundMessage),
      authorized: true,
      command: null,
      adapterState,
      hasPendingApproval: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
      shouldDefer: shouldDeferCodexInboundMessage({
        adapter: slot.adapter,
        status: adapterState.status,
        activeTurnOrigin: adapterState.activeTurnOrigin,
        hasPendingConfirmation: slot.pendingConfirmations.length > 0,
        hasSystemCommand: false,
      }),
      onUnauthorized: async () => undefined,
      handleCommand: async () => false,
      remindPendingApproval: async () => {
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          formatPendingApprovalReminder(slot.pendingConfirmations[0]!, slot.runtime.getState()),
        );
        reason = "pending_approval";
        await sendReminder(routeMessage, "approval_required");
      },
      remindPendingUserInput: async () => {
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          slot.pendingUserInput
            ? formatPendingUserInputReminder(slot.pendingUserInput)
            : `${slot.adapter} is waiting for structured input. Reply with /answer <key>=<value> ...`,
        );
        reason = "pending_user_input";
        await sendReminder(routeMessage, "user_input_required");
      },
      remindBusy: async () => {
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          `${slot.adapter} is still working. Wait for the current reply or use /stop.`,
        );
        reason = "busy";
        await sendReminder(routeMessage, "notice");
      },
      defer: async () => {
        if (slot.deferredInputs.length >= MAX_DAEMON_DEFERRED_INPUTS) {
          routeMessage = prefixDaemonAdapterMessage(
            slot.adapter,
            `The deferred input queue is full (${MAX_DAEMON_DEFERRED_INPUTS}). Wait for the current local turn to finish before retrying.`,
          );
          reason = "busy";
          await sendReminder(routeMessage, "notice");
          return;
        }
        slot.deferredInputs.push({ message: inboundMessage, conversation });
        queuePosition = slot.deferredInputs.length;
        queued = true;
        reason = "deferred";
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          formatDeferredCodexInboundQueueMessage(queuePosition),
        );
        await sendReminder(routeMessage, "notice");
        this.daemonLog(
          `deferred_inbound_input: adapter=${slot.adapter} position=${queuePosition} text=${truncatePreview(inboundMessage.text)}`,
        );
      },
      dispatch: async () => {
        await this.dispatchInboundWechatText(inboundMessage, slot, conversation);
      },
    });
    if (routeResult.kind === "dispatched") {
      return { kind: "dispatched" };
    }
    return {
      kind: routeResult.kind,
      reason: reason ?? (routeResult.kind === "deferred" ? "deferred" : "busy"),
      message: routeMessage,
      ...(queued ? { queued: true } : {}),
      ...(queuePosition !== undefined ? { queuePosition } : {}),
    };
  }

  private restoreActiveAdapterAfterRejectedInput(
    adapter: DaemonAdapterKind,
    activationVersion: number,
    previousActiveAdapter: DaemonAdapterKind | null,
  ): void {
    if (this.activeAdapter === adapter && this.activeAdapterVersion === activationVersion) {
      this.activeAdapter = previousActiveAdapter;
      this.activeAdapterVersion += 1;
    }
  }

  private serializeSlotInput<T>(slot: DaemonSlot, task: () => Promise<T>): Promise<T> {
    const tail = this.slotInputChains.get(slot.adapter) ?? Promise.resolve();
    const run = tail.then(task, task);
    this.slotInputChains.set(slot.adapter, run.then(() => undefined, () => undefined));
    return run;
  }

  private async maybeDrainDeferredInputs(slot: DaemonSlot): Promise<void> {
    if (slot.drainingDeferredInputs) return;
    const state = slot.runtime.getState();
    if (!canDrainDeferredCodexInboundQueue({
      adapter: slot.adapter,
      deferredCount: slot.deferredInputs.length,
      status: state.status,
      activeTurnId: state.activeTurnId,
      hasPendingConfirmation: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
      hasPendingApproval: Boolean(state.pendingApproval),
      hasActiveTask: slot.turns.hasActiveTask,
    })) return;
    const next = slot.deferredInputs.shift();
    if (!next) return;
    slot.drainingDeferredInputs = true;
    try {
      const routed = await this.inboundConversationContext.run(
        next.conversation ?? this.fallbackConversation,
        () => this.routeDaemonInput(slot, next.message, next.conversation ?? this.fallbackConversation),
      );
      if (routed.kind !== "dispatched") {
        slot.deferredInputs.unshift(next);
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (isRetryableDeferredCodexDrainError(errorText)) {
        slot.deferredInputs.unshift(next);
      } else {
        await this.queueWechatMessage(
          next.message.senderId,
          formatUserFacingInboundError({ adapter: slot.adapter, cwd: this.cwd, errorText }),
          "inbound_error",
          next.conversation,
        );
      }
    } finally {
      slot.drainingDeferredInputs = false;
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
    activationVersion: number;
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
    activationVersion: number;
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
    let visibleConnected = this.isVisibleClientAlive(this.cwd, adapter);
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
      const visibleClientTimeoutMs =
        this.deps.visibleClientConnectTimeoutMs ?? VISIBLE_CLIENT_CONNECT_TIMEOUT_MS;
      slot.controller.syncLocalClientEndpoint();
      const launch = this.openVisibleClient({
        adapter,
        cwd: this.cwd,
        // A freshly prepared blank thread is semantically a new session, but
        // the visible client must resume its id from the endpoint instead of
        // creating a second thread of its own.
        sessionStartMode,
        cliArgs: options.cliArgs,
        channelId: this.channelId,
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
        timeoutMs: this.deps.visibleClientConnectTimeoutMs,
      }, {
        isAlive: (cwd, adapter) => this.isVisibleClientAlive(cwd, adapter),
      });
      if (visibleConnected) {
        appendDaemonLog(`visible_client_connected: adapter=${adapter} cwd=${this.cwd}`);
      } else {
        log(
          `${adapter} visible CLI did not connect within ${formatDuration(visibleClientTimeoutMs)}. Check ${BRIDGE_LOG_FILE}.`,
        );
        const cleanedLauncher = cleanupVisibleClientLauncher(launch);
        appendDaemonLog(
          `visible_client_connect_timeout: adapter=${adapter} cwd=${this.cwd} timeout_ms=${visibleClientTimeoutMs} cleaned_launcher=${cleanedLauncher}`,
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
      const previousSlot = this.getActiveSlot();
      if (previousSlot && this.activeAdapter !== adapter) invalidateModelSnapshot(previousSlot.runtime);
      this.activeAdapter = adapter;
      this.activeAdapterVersion += 1;
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
      activationVersion: this.activeAdapterVersion,
      previousActiveAdapter,
    };
  }

  private async createSlot(
    adapter: DaemonAdapterKind,
    options: { profile?: string; sessionStartMode?: BridgeSessionStartMode },
  ): Promise<DaemonSlot> {
    clearLocalCompanionEndpoint(this.cwd, undefined, { adapter });
    const runtime = this.createRuntime({
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
          "message",
          this.resolveSlotOutputTarget(slot),
        );
      }),
      pendingConfirmations: [],
      pendingUserInput: null,
      resumeCoordinator: new ResumeSessionCoordinator({
        adapter,
        runtime,
      }),
      turns: new TurnCoordinator<ActiveTask>({
        restoreLastConversationOnFailure: true,
      }),
      lastOutputAt: 0,
      lastFinalReplyAtMs: 0,
      eventForwardChain: Promise.resolve(),
      deferredInputs: [],
      drainingDeferredInputs: false,
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
    slot.turns.complete();

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

  private createWechatChannelPort(adapter: DaemonAdapterKind): BridgeChannelPort {
    if (this.channelId === "wecom") {
      return new WecomChannelPort({
        transport: this.wecomTransport!,
        sendText: (target, text, kind) =>
          this.queueWechatMessage(
            this.authorizedUserId,
            text,
            toWechatSendContext(kind),
            target,
          ),
        prefixText: (currentAdapter, text) =>
          prefixDaemonAdapterMessage(currentAdapter ?? adapter, text),
        onEmptyVisibleReply: (currentAdapter, rawText) => {
          appendDaemonLog(
            `empty_visible_final_reply: adapter=${currentAdapter ?? adapter} raw=${truncatePreview(rawText)}`,
          );
        },
      });
    }
    return new WechatChannelPort({
      sendText: (recipientId, text, context) =>
        this.queueWechatMessage(recipientId, text, context as WechatSendContext),
      sendImage: (recipientId, filePath) =>
        this.queueWechatAttachmentAction(() => this.transport.sendImage(filePath, { recipientId })),
      sendFile: (recipientId, filePath) =>
        this.queueWechatAttachmentAction(() => this.transport.sendFile(filePath, { recipientId })),
      sendVoice: (recipientId, filePath) =>
        this.queueWechatAttachmentAction(() => this.transport.sendVoice(filePath, recipientId)),
      sendVideo: (recipientId, filePath) =>
        this.queueWechatAttachmentAction(() => this.transport.sendVideo(filePath, { recipientId })),
      prefixText: (currentAdapter, text) =>
        prefixDaemonAdapterMessage(currentAdapter ?? adapter, text),
      onEmptyVisibleReply: (currentAdapter, rawText) => {
        appendDaemonLog(
          `empty_visible_final_reply: adapter=${currentAdapter ?? adapter} raw=${truncatePreview(rawText)}`,
        );
      },
      onTextSent: (currentAdapter, text) => {
        appendDaemonLog(
          `final_reply_sent: adapter=${currentAdapter ?? adapter} chars=${Array.from(text).length}`,
        );
      },
    });
  }

  private handleSlotEvent(slot: DaemonSlot, event: BridgeEvent): void {
    slot.controller.syncLocalClientEndpoint();
    const adapterState = slot.runtime.getState();
    const channelPort = this.createWechatChannelPort(slot.adapter);
    const eventTarget = this.channelDriver.capabilities.multiConversation
      ? this.resolveSlotOutputTarget(slot)
      : this.fallbackConversation;
    const eventTask = slot.turns.activeTask;
    if (slot.pendingConfirmations.length > 0 && !adapterState.pendingApproval) {
      slot.pendingConfirmations = [];
    }
    if (slot.pendingUserInput && !adapterState.pendingUserInput) {
      slot.pendingUserInput = null;
    }

    slot.eventForwardChain = slot.eventForwardChain
      .then(() => forwardBridgeEvent(event, {
      stdout: (next) => {
        slot.lastOutputAt = Date.now();
        if (shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
          slot.outputBatcher.push(next.text);
        }
      },
      stderr: (next) => {
        slot.lastOutputAt = Date.now();
        if (shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
          slot.outputBatcher.push(next.text);
        }
      },
      finalReply: (next) => {
        slot.lastFinalReplyAtMs = Date.now();
        appendDaemonLog(`final_reply: adapter=${slot.adapter} text=${truncatePreview(next.text)}`);
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await channelPort.send({
            target: eventTarget,
            kind: "final_reply",
            text: next.text,
            adapter: slot.adapter,
          });
        }));
      },
      status: (next) => {
        if (next.message) {
          log(`${slot.adapter} ${next.status}: ${next.message}`);
          appendDaemonLog(`${slot.adapter}_${next.status}: ${next.message}`);
        }
      },
      notice: (next) => {
        slot.lastOutputAt = Date.now();
        appendDaemonLog(`${slot.adapter}_${next.level}_notice: ${truncatePreview(next.text)}`);
        if (shouldForwardBridgeEventToWechat(slot.adapter, next.type, { text: next.text })) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, next.text), "notice", eventTarget);
          }));
        }
      },
      approvalRequired: (next) => {
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          const pending = toPendingApproval(next);
          slot.pendingConfirmations.push(pending);
          appendDaemonLog(`approval_required: adapter=${slot.adapter} source=${pending.source} command=${truncatePreview(pending.commandPreview)}`);
          await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatApprovalMessage(pending, adapterState)), "approval_required", eventTarget);
        }));
      },
      userInputRequired: (next) => {
        const pending = toPendingUserInput(next.request);
        slot.pendingUserInput = pending;
        appendDaemonLog(`user_input_required: adapter=${slot.adapter} questions=${pending.questions.length}`);
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatUserInputRequestMessage(pending, adapterState)), "user_input_required", eventTarget);
        }));
      },
      mirroredUserInput: (next) => {
        appendDaemonLog(`mirrored_local_input: adapter=${slot.adapter} text=${truncatePreview(next.text)}`);
        if (shouldForwardBridgeEventToWechat(slot.adapter, next.type, { text: next.text })) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatMirroredUserInputMessage(slot.adapter, next.text)), "mirrored_user_input", eventTarget);
          }));
        }
      },
      sessionSwitched: (next) => {
        if (next.source === "local") slot.resumeCoordinator.clear();
        appendDaemonLog(`session_switched: adapter=${slot.adapter} session=${next.sessionId} source=${next.source} reason=${next.reason}`);
        if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatSessionSwitchMessage({ adapter: slot.adapter, sessionId: next.sessionId, source: next.source, reason: next.reason })), "session_switched", eventTarget);
          }));
        }
      },
      threadSwitched: (next) => {
        if (next.source === "local") slot.resumeCoordinator.clear();
        appendDaemonLog(`thread_switched: adapter=${slot.adapter} thread=${next.threadId} source=${next.source} reason=${next.reason}`);
        if (
          shouldSuppressCodexLocalThreadNotice({
            adapter: slot.adapter,
            source: next.source,
            activeTurnOrigin: slot.runtime.getState().activeTurnOrigin,
            lastFinalReplyAtMs: slot.lastFinalReplyAtMs,
          })
        ) {
          return;
        }
        if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatSessionSwitchMessage({ adapter: slot.adapter, sessionId: next.threadId, source: next.source, reason: next.reason })), "thread_switched", eventTarget);
          }));
        }
      },
      taskComplete: () => {
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(() => {
          slot.pendingConfirmations = [];
          slot.pendingUserInput = null;
          if (eventTask) {
            slot.turns.complete(eventTask);
          }
          void this.maybeDrainDeferredInputs(slot);
        }));
      },
      taskFailed: (next) => {
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          slot.pendingConfirmations = [];
          slot.pendingUserInput = null;
          if (eventTask) {
            slot.turns.complete(eventTask);
          }
          void this.maybeDrainDeferredInputs(slot);
          await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatTaskFailedMessage(slot.adapter, next.message)), "task_failed", eventTarget);
        }));
      },
      fatalError: (next) => {
        logError(`${slot.adapter}: ${next.message}`);
        appendDaemonLog(`fatal_error: adapter=${slot.adapter} message=${next.message}`);
        slot.pendingConfirmations = [];
        slot.pendingUserInput = null;
        if (eventTask) {
          slot.turns.complete(eventTask);
        }
        void this.maybeDrainDeferredInputs(slot);
        this.disposeDeadSlot(slot);
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await this.queueWechatMessage(this.authorizedUserId, prefixDaemonAdapterMessage(slot.adapter, formatUserFacingBridgeFatalError(next.message)), "fatal_error", eventTarget);
        }));
      },
      shutdownRequested: (next) => {
        appendDaemonLog(`slot_shutdown_requested: adapter=${slot.adapter} reason=${next.reason}`);
      },
      }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        appendDaemonLog(`event_forward_failed: adapter=${slot.adapter} message=${message}`);
      });
  }

  private resolveSlotOutputTarget(slot: DaemonSlot): ChannelConversationRef {
    return slot.turns.resolveTarget(this.fallbackConversation);
  }

  private bindCurrentWecomConversation(slot: DaemonSlot | null): void {
    const conversation = this.inboundConversationContext.get();
    if (!this.channelDriver.capabilities.multiConversation || !slot || !conversation) {
      return;
    }
    slot.turns.observeConversation(conversation);
  }

  private async handleInboundMessage(message: InboundWechatMessage): Promise<void> {
    if (message.senderId !== this.authorizedUserId) {
      await this.queueWechatMessage(
        message.senderId,
        `Unauthorized. This daemon only accepts messages from ${this.channelDriver.operatorDescription}.`,
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
          this.bindCurrentWecomConversation(this.getActiveSlot());
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
      this.bindCurrentWecomConversation(this.getActiveSlot());
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
      await this.queueWechatMessage(
        message.senderId,
        `Stopping ${this.channelId}-daemon...`,
      );
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
    this.bindCurrentWecomConversation(slot);

    const routeCurrentMessage = async (
      currentSlot: DaemonSlot,
      command: ReturnType<typeof parseWechatControlCommand>,
    ): Promise<void> => {
      const previousTask = currentSlot.turns.activeTask;
      await routeBridgeMessage({
        message: toChannelInboundMessage(message),
        authorized: true,
        command,
        adapterState: currentSlot.runtime.getState(),
        hasPendingApproval: currentSlot.pendingConfirmations.length > 0,
        hasPendingUserInput: Boolean(currentSlot.pendingUserInput),
        onUnauthorized: async () => undefined,
        handleCommand: async (nextCommand) => {
          await this.handleSystemCommand(message, currentSlot, nextCommand);
          return true;
        },
        remindPendingApproval: async () => {
          await this.queueWechatMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              currentSlot.adapter,
              formatPendingApprovalReminder(
                currentSlot.pendingConfirmations[0]!,
                currentSlot.runtime.getState(),
              ),
            ),
          );
        },
        remindPendingUserInput: async () => {
          await this.queueWechatMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              currentSlot.adapter,
              currentSlot.pendingUserInput
                ? formatPendingUserInputReminder(currentSlot.pendingUserInput)
                : `${currentSlot.adapter} is waiting for structured input. Reply with /answer <key>=<value> ...`,
            ),
          );
        },
        remindBusy: async () => {
          await this.queueWechatMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              currentSlot.adapter,
              `${currentSlot.adapter} is still working. Wait for the current reply or use /stop.`,
            ),
          );
        },
        defer: async () => undefined,
        dispatch: async () => {
          await this.dispatchInboundWechatText(message, currentSlot);
        },
      });
      if (
        this.channelDriver.capabilities.multiConversation &&
        this.inboundConversationContext.get() &&
        currentSlot.turns.activeTask &&
        currentSlot.turns.activeTask !== previousTask
      ) {
        const conversation = this.inboundConversationContext.get()!;
        currentSlot.turns.bindConversation(conversation);
      }
    };

    const command = parseWechatControlCommand(message.text, {
      adapter: slot.adapter,
      hasPendingConfirmation: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
    });
    const slotState = slot.runtime.getState();
    if (
      command ||
      slot.pendingConfirmations.length > 0 ||
      slot.pendingUserInput ||
      slotState.status === "awaiting_input"
    ) {
      await routeCurrentMessage(slot, command);
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
    this.bindCurrentWecomConversation(slot);
    await routeCurrentMessage(slot, null);
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
      case "model":
      case "plan":
        await this.queueWechatMessage(message.senderId, await handleAdapterControl(activeSlot.runtime, message.senderId, command));
        return;
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
            `${this.channelDriver.displayName} /resume is disabled for ${activeSlot.adapter} in daemon mode. Use /resume directly inside the visible terminal; the remote channel will follow that local session.`,
          );
          return;
        }
        try {
          let resumeSlot = activeSlot;
          if (activeSlot.adapter === "codex" && command.target) {
            const visible = await this.ensureSlot("codex", {
              openVisible: true,
              reuseExistingVisible: true,
            });
            if (!visible.activated) {
              throw new Error(formatDaemonSwitchResultDetail(visible));
            }
            resumeSlot = this.slots.get("codex") ?? activeSlot;
          }
          if (command.target) {
            await resumeSlot.outputBatcher.flushNow();
          }
          const taskBeforeResume = resumeSlot.turns.activeTask;
          const result = await resumeSlot.resumeCoordinator.execute(command.target);
          if (result.kind === "resumed" && taskBeforeResume) {
            resumeSlot.turns.complete(taskBeforeResume);
          }
          await this.queueWechatMessage(
            message.senderId,
            prefixDaemonAdapterMessage(resumeSlot.adapter, result.message),
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
    slot.turns.setActiveTask({
      startedAt: Date.now(),
      inputPreview: preview,
    });
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
    slot.turns.setActiveTask({
      startedAt: Date.now(),
      inputPreview: parsed.preview,
    });
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
    conversationOverride?: ChannelConversationRef,
  ): Promise<TurnDispatchResult<ActiveTask>> {
    const preview = formatInboundMessagePreview(message);
    const nextTask = {
      startedAt: Date.now(),
      inputPreview: truncatePreview(preview, 180),
    };
    const inboundConversation = this.channelDriver.capabilities.multiConversation
      ? conversationOverride ?? this.inboundConversationContext.get()
      : undefined;
    return slot.turns.dispatch({
      task: nextTask,
      conversation: inboundConversation,
      onBusy: async () => {
        await this.queueWechatMessage(
          message.senderId,
          prefixDaemonAdapterMessage(
            slot.adapter,
            `${slot.adapter} is still working. Wait for the current reply or use /stop.`,
          ),
          "notice",
          conversationOverride,
        );
      },
      forward: async () => {
        appendDaemonLog(
          `forwarded_input: adapter=${slot.adapter} text=${truncatePreview(preview)}`,
        );
        await slot.runtime.sendInput(
          this.channelDriver.buildInboundPrompt(message.text, message.attachments),
        );
      },
    });
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

  private async sendWechatMessageNow(
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
    targetOverride?: ChannelConversationRef,
  ): Promise<WechatSendResult> {
    const activeSlot = this.getActiveSlot();
    const target = resolveDaemonOutboundTarget({
      senderId,
      operatorId: this.authorizedUserId,
      override: targetOverride,
      multiConversation: this.channelDriver.capabilities.multiConversation,
      inboundConversation: this.channelDriver.capabilities.multiConversation
        ? this.inboundConversationContext.get()
        : null,
      activeSlotTarget: activeSlot ? this.resolveSlotOutputTarget(activeSlot) : null,
      fallbackConversation: this.fallbackConversation,
      directConversation: (id) => this.channelDriver.directConversation(id),
    });
    return this.channelDriver.sendText({
      target,
      text,
      context,
      log: appendDaemonLog,
    });
  }

  private queueWechatMessage(
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
    targetOverride?: ChannelConversationRef,
  ): Promise<boolean> {
    const activeSlot = this.getActiveSlot();
    const queuedTarget = this.channelDriver.capabilities.multiConversation && senderId === this.authorizedUserId
      ? targetOverride ??
        this.inboundConversationContext.get() ??
        (activeSlot ? this.resolveSlotOutputTarget(activeSlot) : this.fallbackConversation)
      : targetOverride;
    return this.queueWechatTextAction(async () => {
      const result = await this.sendWechatMessageNow(
        senderId,
        text,
        context,
        queuedTarget,
      );
      if (result.status === "target_stale") {
        const pending = this.pendingWechatMessages.enqueue(
          senderId,
          text,
          context,
          result.target,
        );
        if (pending) {
          appendDaemonLog(
            `wechat_send_queued: id=${pending.id} context=${context} recipient=${senderId} pending=${this.pendingWechatMessages.list().length}`,
          );
        }
      }
      return result.status === "sent";
    });
  }

  private flushPendingWechatMessages(): Promise<void> {
    return this.queueWechatTextAction(async () => {
      for (const pending of this.pendingWechatMessages.list()) {
        const result = await this.sendWechatMessageNow(
          pending.recipientId,
          pending.text,
          pending.context,
          pending.target,
        );
        if (result.status === "sent") {
          this.pendingWechatMessages.remove(pending.id);
          appendDaemonLog(
            `wechat_pending_sent: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
          );
          continue;
        }
        if (result.status === "target_stale") {
          break;
        }
        appendDaemonLog(
          `wechat_pending_retryable_failure: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
        );
        break;
      }
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
  if ((options.channelId ?? "wechat") === "wechat") {
    migrateLegacyChannelFiles((message) => log(message));
  }
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
  const wecomAccount =
    options.channelId === "wecom"
      ? await ensureWecomAccount({ log })
      : null;
  const credentials = wecomAccount
    ? { userId: wecomAccount.operatorUserId }
    : await ensureWechatCredentials({
        requireUserId: true,
        validateExisting: true,
        log,
      });
  if (!credentials.userId) {
    throw new Error(
      options.channelId === "wecom"
        ? "Saved WeCom credentials are missing operatorUserId."
        : "Saved WeChat credentials are missing userId.",
    );
  }

  const daemon = new WechatDaemon({
    cwd: options.cwd,
    profile: options.profile,
    authorizedUserId: credentials.userId,
    transport: new WeChatTransport({ log, logError }),
    channelId: options.channelId,
    accountId: wecomAccount?.botId,
    wecomTransport: wecomAccount
      ? new WecomTransport({
          account: wecomAccount,
          logger: {
            log: (message) => log(message),
            error: (message) => logError(message),
          },
        })
      : null,
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
      // Remove this process's endpoint synchronously so a new terminal can be
      // started immediately even if asynchronous adapter cleanup takes time.
      clearDaemonEndpoint();
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

const isDirectRun = isDirectModuleRun(
  import.meta.url,
  process.argv,
  (import.meta as ImportMeta & { main?: boolean }).main,
);
if (isDirectRun) {
  void main();
}
