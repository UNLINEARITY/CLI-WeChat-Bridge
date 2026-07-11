import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { t } from "../i18n/index.ts";
import { spawn as spawnPty } from "node-pty";

import type {
  ApprovalRequest,
  BridgeAdapterKind,
  BridgeLifecycleMode,
  BridgeSessionStartMode,
  BridgeResumeSessionCandidate,
  BridgeResumeThreadCandidate,
  BridgeAdapterState,
  BridgeEvent,
  BridgeTurnOrigin,
  UserInputRequest,
  UserInputRequestOption,
} from "./bridge-types.ts";
import {
  WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE,
  containsWechatOutboundAttachmentPath,
  containsWechatOutboundAttachmentPathDeep,
  isWechatOutboundAttachmentWriteCommand,
  isHighRiskShellCommand,
  isStrictApprovalModeEnabled,
  normalizeOutput,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  getNotificationThreadId,
  isRecord,
  type CodexRpcRequestId,
} from "./bridge-adapter-common.ts";

export {
  coerceWebSocketMessageData,
  describeUnknownError,
  getCodexRpcRequestId,
  getLocalCompanionCommandName,
  getNotificationThreadId,
  getNotificationTurnId,
  getSharedSessionIdFromAdapterState,
  isRecentIsoTimestamp,
  isRecord,
  normalizeCodexRpcError,
  quotePosixCommandArg,
  quoteWindowsCommandArg,
  type CodexRpcRequestId,
} from "./bridge-adapter-common.ts";

export type AdapterOptions = {
  kind: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  extraCliArgs?: string[];
  lifecycle?: BridgeLifecycleMode;
  sessionStartMode?: BridgeSessionStartMode;
  companionLaunchMode?: "manual" | "daemon_auto";
  initialSharedSessionId?: string;
  initialSharedThreadId?: string;
  initialResumeConversationId?: string;
  initialTranscriptPath?: string;
  renderMode?: "embedded" | "panel" | "companion" | "headless";
};

export type EventSink = (event: BridgeEvent) => void;

export type SpawnTarget = {
  file: string;
  args: string[];
};

export type ResolveSpawnTargetOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  forwardArgs?: string[];
};

export type CodexRpcPendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export type CodexQueuedNotification = {
  method: string;
  params: Record<string, unknown>;
};

export type CodexPendingApprovalRequest = {
  requestId: CodexRpcRequestId;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  threadId: string;
  turnId: string;
  origin: BridgeTurnOrigin;
  params: Record<string, unknown>;
};

export type CodexPendingUserInputRequest = {
  requestId: CodexRpcRequestId;
  method: "item/tool/requestUserInput";
  threadId: string;
  turnId: string;
  origin: BridgeTurnOrigin;
};

export type CodexApprovalAutoResponse = {
  result: Record<string, unknown>;
  reason: string;
};

export type CodexActiveTurn = {
  threadId: string;
  turnId: string;
  origin: BridgeTurnOrigin;
};

export type CodexSessionMeta = {
  id?: string;
  timestamp?: string;
  cwd?: string;
  source?: string | { custom?: string };
  originator?: string;
};

export type CodexSessionSummary = {
  threadId: string;
  title: string;
  lastUpdatedAt: string;
  source?: string;
  filePath: string;
};

export type CodexRecentSessionFile = {
  threadId: string;
  filePath: string;
  modifiedAtMs: number;
};

export type ClaudePendingHookApproval = {
  requestId: string;
  socket: net.Socket;
};

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
export const WINDOWS_POWERSHELL_EXTENSION = ".ps1";
export const CODEX_SESSION_POLL_INTERVAL_MS = 500;
export const CODEX_SESSION_MATCH_WINDOW_MS = 30_000;
export const CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS = 5_000;
export const CODEX_THREAD_SIGNAL_TTL_MS = 30_000;
export const CODEX_RECENT_SESSION_KEY_LIMIT = 64;
export const INTERRUPT_SETTLE_DELAY_MS = 1_500;
export const CODEX_FINAL_REPLY_SETTLE_DELAY_MS = 1_000;
export const CODEX_STARTUP_WARMUP_MS = 1_200;
export const CODEX_APP_SERVER_HOST = "127.0.0.1";
export const CODEX_APP_SERVER_READY_TIMEOUT_MS = 10_000;
export const CODEX_APP_SERVER_LOG_LIMIT = 12_000;
export const CODEX_RPC_CONNECT_RETRY_MS = 150;
export const CODEX_RPC_RECONNECT_TIMEOUT_MS = 5_000;
export const CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS = 15_000;
export const LOCAL_COMPANION_RECONNECT_GRACE_MS = 15_000;
export const CLAUDE_HOOK_LISTEN_HOST = "127.0.0.1";
export const CLAUDE_HELP_PROBE_TIMEOUT_MS = 5_000;
export const CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS = 12_000;
export const DEFAULT_UNIX_SHELL_CANDIDATES = ["pwsh", "bash", "zsh", "sh"] as const;
export const POSIX_SHELL_NAMES = new Set(["bash", "zsh", "sh", "dash", "ksh"]);
export const CLAUDE_FLAG_SUPPORT_CACHE = new Map<string, boolean>();
export const OPENCODE_SERVER_HOST = "127.0.0.1";
export const OPENCODE_SERVER_READY_TIMEOUT_MS = 10_000;
export const OPENCODE_SSE_RECONNECT_DELAY_MS = 2_000;
export const OPENCODE_SESSION_IDLE_SETTLE_MS = 1_500;
export const OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS = 12_000;
// `opencode serve` binds its TCP port before the HTTP layer is ready. The
// health probe therefore retries within this total budget so the startup
// race self-heals instead of hanging until undici's ~300s headersTimeout.
export const OPENCODE_HTTP_READY_TIMEOUT_MS = 15_000;
export const OPENCODE_HTTP_READY_PROBE_TIMEOUT_MS = 3_000;
export const OPENCODE_HTTP_READY_PROBE_INTERVAL_MS = 500;

export type ShellRuntimeFamily = "powershell" | "posix";

export type ShellRuntime = {
  family: ShellRuntimeFamily;
  launchArgs: string[];
};

export function buildCodexCliArgs(
  remoteUrl: string,
  options: {
    profile?: string;
    inlineMode?: boolean;
    resumeThreadId?: string;
    extraCliArgs?: string[];
  } = {},
): string[] {
  assertNoReservedExtraCliArgs(
    options.extraCliArgs ?? [],
    ["--remote", "--remote-auth-token-env"],
    "Codex remote connection",
  );

  const args: string[] = [];

  if (options.resumeThreadId) {
    args.push("resume", options.resumeThreadId);
  }

  args.push("--enable", "tui_app_server", "--remote", remoteUrl);

  if (options.inlineMode) {
    args.push("--no-alt-screen");
  }

  if (options.profile) {
    args.push("--profile", options.profile);
  }

  return [...args, ...(options.extraCliArgs ?? [])];
}

export function hasClaudeNoAltScreenOption(helpText: string): boolean {
  return helpText.includes("--no-alt-screen");
}

export function buildClaudeCliArgs(options: {
  settingsFilePath: string;
  resumeConversationId?: string | null;
  profile?: string;
  includeNoAltScreen?: boolean;
  extraCliArgs?: string[];
}): string[] {
  assertNoReservedExtraCliArgs(
    options.extraCliArgs ?? [],
    ["--settings"],
    "Claude companion settings",
  );

  const args: string[] = [];
  if (options.includeNoAltScreen) {
    args.push("--no-alt-screen");
  }
  args.push("--settings", options.settingsFilePath);
  if (options.resumeConversationId) {
    args.push("--resume", options.resumeConversationId);
  }
  if (options.profile) {
    args.push("--profile", options.profile);
  }
  return [...args, ...(options.extraCliArgs ?? [])];
}

export function assertNoReservedExtraCliArgs(
  args: string[],
  reservedOptions: string[],
  owner: string,
): void {
  const blocked = args.find((arg) =>
    reservedOptions.some((option) => arg === option || arg.startsWith(`${option}=`)),
  );
  if (!blocked) {
    return;
  }

  throw new Error(`${owner} is managed by the WeChat bridge; do not pass ${blocked} as an extra CLI argument.`);
}

export function isClaudeInvalidResumeError(text: string): boolean {
  const normalized = normalizeOutput(text);
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("No conversation found with session ID:") ||
    normalized.includes("No conversation found with session name:") ||
    normalized.includes("No conversation found with session:")
  );
}

export function shouldIncludeClaudeNoAltScreen(command: string): boolean {
  let spawnTarget: SpawnTarget;
  try {
    spawnTarget = resolveSpawnTarget(command, "claude");
  } catch {
    return false;
  }

  const cacheKey = `${spawnTarget.file}\u0000${spawnTarget.args.join("\u0000")}`;
  const cached = CLAUDE_FLAG_SUPPORT_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let supported: boolean;
  try {
    const probe = spawnSync(spawnTarget.file, [...spawnTarget.args, "--help"], {
      cwd: process.cwd(),
      env: buildCliEnvironment("claude"),
      encoding: "utf8",
      timeout: CLAUDE_HELP_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
    supported = hasClaudeNoAltScreenOption(output);
  } catch {
    supported = false;
  }

  CLAUDE_FLAG_SUPPORT_CACHE.set(cacheKey, supported);
  return supported;
}

export function buildCodexApprovalRequest(
  method: string,
  params: unknown,
): ApprovalRequest | null {
  if (!isRecord(params)) {
    return null;
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview =
      command && cwd
        ? `${command} (${cwd})`
        : command || reason || "Command execution approval requested.";

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before running a command: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before running a command.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview = grantRoot || reason || "File change approval requested.";

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before applying a file change: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before applying a file change.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  if (method === "item/permissions/requestApproval") {
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview = summarizeCodexPermissionsRequest(params.permissions);

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before granting extra permissions: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before granting extra permissions.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  return null;
}

export function getCodexWechatOutboundAttachmentDenyMessage(
  method: string,
  params: unknown,
): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (method === "item/commandExecution/requestApproval") {
    return isWechatOutboundAttachmentWriteCommand(params.command) ||
      containsWechatOutboundAttachmentPathDeep(params.additionalPermissions)
      ? WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE
      : null;
  }

  if (method === "item/fileChange/requestApproval") {
    return containsWechatOutboundAttachmentPath(params.grantRoot)
      ? WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE
      : null;
  }

  if (method === "item/permissions/requestApproval") {
    return containsWechatOutboundAttachmentPathDeep(params.permissions)
      ? WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE
      : null;
  }

  return null;
}

function commandApprovalAllowsAccept(availableDecisions: unknown): boolean {
  if (!Array.isArray(availableDecisions)) {
    return true;
  }

  return availableDecisions.some((decision) => decision === "accept");
}

function normalizePermissionPath(pathValue: string): string {
  const normalized = pathValue.trim().replace(/\\/g, "/").toLowerCase();
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
}

function isHighRiskPermissionPath(pathValue: string): boolean {
  const normalized = normalizePermissionPath(pathValue);
  if (!normalized) {
    return false;
  }

  if (normalized === "/" || /^[a-z]:$/i.test(normalized)) {
    return true;
  }

  return /^[a-z]:(?:\/windows|\/program files(?: \(x86\))?|\/programdata)(?:\/|$)/i.test(normalized);
}

function collectPermissionPaths(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPermissionPaths(item, output);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (typeof value.path === "string") {
    output.push(value.path);
  }
  if (typeof value.pattern === "string") {
    output.push(value.pattern);
  }

  for (const item of Object.values(value)) {
    collectPermissionPaths(item, output);
  }
}

function hasRootSpecialPermissionPath(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasRootSpecialPermissionPath);
  }

  if (!isRecord(value)) {
    return false;
  }

  if (
    (value.kind === "root" || value.kind === "Root") ||
    (value.value === "root" || value.value === "Root")
  ) {
    return true;
  }

  return Object.values(value).some(hasRootSpecialPermissionPath);
}

function containsHighRiskPermissionTarget(value: unknown): boolean {
  if (hasRootSpecialPermissionPath(value)) {
    return true;
  }

  const paths: string[] = [];
  collectPermissionPaths(value, paths);
  return paths.some(isHighRiskPermissionPath);
}

export function getCodexApprovalAutoResponse(
  method: CodexPendingApprovalRequest["method"],
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): CodexApprovalAutoResponse | null {
  if (isStrictApprovalModeEnabled(env)) {
    return null;
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    if (!commandApprovalAllowsAccept(params.availableDecisions)) {
      return null;
    }
    if (command && isHighRiskShellCommand(command)) {
      return null;
    }
    if (containsHighRiskPermissionTarget(params.additionalPermissions)) {
      return null;
    }

    return {
      result: { decision: "accept" },
      reason: command
        ? `low-risk command ${truncatePreview(command, 120)}`
        : "low-risk command approval",
    };
  }

  if (method === "item/fileChange/requestApproval") {
    if (containsHighRiskPermissionTarget(params.grantRoot)) {
      return null;
    }

    return {
      result: { decision: "accept" },
      reason: "low-risk file change approval",
    };
  }

  if (method === "item/permissions/requestApproval") {
    if (containsHighRiskPermissionTarget(params.permissions)) {
      return null;
    }

    return {
      result: buildCodexPermissionsRequestApprovalResponse(params, "confirm", {
        strictAutoReview: true,
      }),
      reason: "low-risk permission grant",
    };
  }

  return null;
}

function collectStringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function summarizeCodexPermissionsRequest(permissions: unknown): string {
  if (!isRecord(permissions)) {
    return "Additional permissions requested.";
  }

  const parts: string[] = [];
  if (isRecord(permissions.network) && permissions.network.enabled === true) {
    parts.push("network access");
  }

  if (isRecord(permissions.fileSystem)) {
    const readPaths = collectStringValues(permissions.fileSystem.read);
    const writePaths = collectStringValues(permissions.fileSystem.write);
    if (readPaths.length > 0) {
      parts.push(`read: ${readPaths.join(", ")}`);
    }
    if (writePaths.length > 0) {
      parts.push(`write: ${writePaths.join(", ")}`);
    }
    if (Array.isArray(permissions.fileSystem.entries) && permissions.fileSystem.entries.length > 0) {
      parts.push(`filesystem entries: ${permissions.fileSystem.entries.length}`);
    }
  }

  return parts.length > 0 ? parts.join("; ") : "Additional permissions requested.";
}

function clonePermissionObject(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function buildCodexPermissionsRequestApprovalResponse(
  params?: unknown,
  action: "confirm" | "deny" = "deny",
  options: { strictAutoReview?: boolean } = {},
): Record<string, unknown> {
  const permissions: Record<string, unknown> = {};
  if (action === "confirm" && isRecord(params) && isRecord(params.permissions)) {
    const network = clonePermissionObject(params.permissions.network);
    const fileSystem = clonePermissionObject(params.permissions.fileSystem);
    if (network) {
      permissions.network = network;
    }
    if (fileSystem) {
      permissions.fileSystem = fileSystem;
    }
  }

  const response: Record<string, unknown> = {
    permissions,
    scope: "turn",
  };
  if (options.strictAutoReview) {
    response.strictAutoReview = true;
  }
  return response;
}

export function buildCodexMcpServerElicitationDeclineResponse(): Record<string, unknown> {
  return {
    action: "decline",
    content: null,
    _meta: null,
  };
}

export function buildCodexDynamicToolCallFailureResponse(): Record<string, unknown> {
  return {
    contentItems: [
      {
        type: "inputText",
        text: "Dynamic tool calls are not supported by the WeChat bridge.",
      },
    ],
    success: false,
  };
}

export function buildCodexUserInputRequest(params: unknown): UserInputRequest | null {
  if (!isRecord(params) || !Array.isArray(params.questions)) {
    return null;
  }

  const questions = params.questions
    .map((question) => {
      if (!isRecord(question)) {
        return null;
      }

      const id = typeof question.id === "string" ? question.id.trim() : "";
      const header = typeof question.header === "string" ? question.header.trim() : "";
      const prompt = typeof question.question === "string" ? normalizeOutput(question.question).trim() : "";
      if (!id || !header || !prompt) {
        return null;
      }

      const options: UserInputRequestOption[] | null = Array.isArray(question.options)
        ? question.options
            .map((option) => {
              if (!isRecord(option)) {
                return null;
              }
              const label = typeof option.label === "string" ? option.label.trim() : "";
              const description =
                typeof option.description === "string"
                  ? normalizeOutput(option.description).trim()
                  : "";
              if (!label || !description) {
                return null;
              }
              return {
                label,
                description,
              };
            })
            .filter((option): option is UserInputRequestOption => Boolean(option))
        : null;

      return {
        id,
        header,
        question: prompt,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options,
      };
    })
    .filter((question): question is NonNullable<typeof question> => Boolean(question));

  if (questions.length === 0) {
    return null;
  }

  return {
    summary: "Codex needs more information before the tool can continue.",
    questions,
  };
}

export function extractCodexFinalTextFromItem(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "agentMessage" || item.phase !== "final_answer") {
    return null;
  }

  const text = typeof item.text === "string" ? normalizeOutput(item.text).trim() : "";
  return text || null;
}

export function extractCodexUserMessageText(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "userMessage" || !Array.isArray(item.content)) {
    return null;
  }

  const parts = item.content
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.type !== "string") {
        return "";
      }

      switch (entry.type) {
        case "text":
          return typeof entry.text === "string" ? entry.text : "";
        case "image":
          return "[image]";
        case "localImage":
          return typeof entry.path === "string" ? `[local image: ${entry.path}]` : "[local image]";
        case "skill":
          return typeof entry.name === "string" ? `[skill: ${entry.name}]` : "[skill]";
        case "mention":
          return typeof entry.name === "string" ? `[mention: ${entry.name}]` : "[mention]";
        default:
          return "";
      }
    })
    .filter(Boolean);

  const text = normalizeOutput(parts.join("\n")).trim();
  return text || null;
}

export function extractCodexThreadFollowIdFromStatusChanged(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  const threadId = getNotificationThreadId(params);
  if (!threadId) {
    return null;
  }

  const status = isRecord(params.status) ? params.status : null;
  if (!status) {
    return threadId;
  }

  const statusType = typeof status.type === "string" ? status.type : "";
  if (statusType === "notLoaded") {
    return null;
  }

  if (statusType === "active" || statusType === "idle" || statusType === "systemError") {
    return threadId;
  }

  return threadId;
}

export function extractCodexThreadStartedThreadId(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params.thread)) {
    return null;
  }

  return typeof params.thread.id === "string" ? params.thread.id : null;
}

export function shouldIgnoreCodexSessionReplayEntry(
  timestamp: unknown,
  ignoreBeforeMs: number | null,
): boolean {
  if (ignoreBeforeMs === null) {
    return false;
  }
  if (typeof timestamp !== "string") {
    return true;
  }

  const parsedTimestampMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestampMs)) {
    return true;
  }

  return parsedTimestampMs < ignoreBeforeMs;
}

export function shouldRecoverCodexStaleBusyState(params: {
  status: BridgeAdapterState["status"];
  pendingTurnStart: boolean;
  hasActiveTurn: boolean;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  activeTurnId?: string;
}): boolean {
  return (
    params.status === "busy" &&
    !params.pendingTurnStart &&
    !params.hasActiveTurn &&
    !params.hasPendingApproval &&
    !params.hasPendingUserInput &&
    !params.activeTurnId
  );
}

export function shouldAutoCompleteCodexWechatTurnAfterFinalReply(params: {
  candidateTurnId: string | null;
  activeTurnId?: string;
  activeTurnOrigin?: BridgeTurnOrigin;
  pendingTurnStart: boolean;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  hasFinalOutput: boolean;
  hasCompletedTurn: boolean;
  lastActivityAtMs: number | null;
  nowMs: number;
  settleDelayMs: number;
}): boolean {
  return (
    typeof params.candidateTurnId === "string" &&
    params.activeTurnId === params.candidateTurnId &&
    params.activeTurnOrigin === "wechat" &&
    !params.pendingTurnStart &&
    !params.hasPendingApproval &&
    !params.hasPendingUserInput &&
    params.hasFinalOutput &&
    !params.hasCompletedTurn &&
    typeof params.lastActivityAtMs === "number" &&
    Number.isFinite(params.lastActivityAtMs) &&
    params.nowMs - params.lastActivityAtMs >= params.settleDelayMs
  );
}

export function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const direct = env[key];
  if (direct !== undefined) {
    return direct;
  }

  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey ? env[matchedKey] : undefined;
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isPathLikeCommand(command: string): boolean {
  return (
    path.isAbsolute(command) ||
    command.startsWith(".") ||
    command.includes("/") ||
    command.includes("\\")
  );
}

export function getWindowsCommandExtensions(
  env: Record<string, string | undefined>,
): string[] {
  const configured = (getEnvValue(env, "PATHEXT") ?? "")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const ordered = [...WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS, "", WINDOWS_POWERSHELL_EXTENSION];
  for (const extension of configured) {
    if (!ordered.includes(extension)) {
      ordered.push(extension);
    }
  }
  return ordered;
}

export function expandCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform !== "win32") {
    return [command];
  }

  if (path.extname(command)) {
    return [command];
  }

  return getWindowsCommandExtensions(env).map((extension) => `${command}${extension}`);
}

export function resolvePathLikeCommand(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const absoluteCommand = path.resolve(command);
  for (const candidate of expandCommandCandidates(absoluteCommand, platform, env)) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function findCommandOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const pathEntries = (getEnvValue(env, "PATH") ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidates = expandCommandCandidates(command, platform, env);
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const candidatePath = path.join(directory, candidate);
      if (fileExists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

export function resolveCommandPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  if (isPathLikeCommand(command)) {
    return resolvePathLikeCommand(command, platform, env);
  }

  return findCommandOnPath(command, platform, env);
}

export function resolveCmdExe(env: Record<string, string | undefined>): string {
  const systemRoot = getEnvValue(env, "SystemRoot") ?? getEnvValue(env, "SYSTEMROOT");
  const configured =
    getEnvValue(env, "ComSpec") ??
    getEnvValue(env, "COMSPEC") ??
    (systemRoot ? `${systemRoot.replace(/[\\/]$/, "")}\\System32\\cmd.exe` : undefined);

  return configured || "cmd.exe";
}

export function quoteForCmd(argument: string): string {
  if (!argument) {
    return '""';
  }

  if (!/[\s"]/u.test(argument)) {
    return argument;
  }

  return `"${argument.replace(/"/g, '""')}"`;
}

export function wrapWithCmdExe(
  scriptPath: string,
  extraArgs: string[],
  env: Record<string, string | undefined>,
): SpawnTarget {
  const commandLine = [quoteForCmd(scriptPath), ...extraArgs.map(quoteForCmd)].join(" ");
  return {
    file: resolveCmdExe(env),
    args: ["/d", "/s", "/c", commandLine],
  };
}

export function resolveBundledWindowsExe(
  kind: Extract<BridgeAdapterKind, "codex" | "claude">,
  launcherPath: string,
): string | undefined {
  const launcherDirectory = path.dirname(launcherPath);
  const openAiDirectory = path.join(launcherDirectory, "node_modules", "@openai");
  if (!fs.existsSync(openAiDirectory)) {
    return undefined;
  }

  const vendorSegments = [
    "vendor",
    "x86_64-pc-windows-msvc",
    kind,
    `${kind}.exe`,
  ];

  const directCandidate = path.join(
    openAiDirectory,
    `${kind}-win32-x64`,
    ...vendorSegments,
  );
  if (fileExists(directCandidate)) {
    return directCandidate;
  }

  const packageCandidate = path.join(
    openAiDirectory,
    kind,
    "node_modules",
    "@openai",
    `${kind}-win32-x64`,
    ...vendorSegments,
  );
  if (fileExists(packageCandidate)) {
    return packageCandidate;
  }

  const dirEntries = fs.readdirSync(openAiDirectory, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`.${kind}-`)) {
      continue;
    }

    const nestedCandidate = path.join(
      openAiDirectory,
      entry.name,
      "node_modules",
      "@openai",
      `${kind}-win32-x64`,
      ...vendorSegments,
    );
    if (fileExists(nestedCandidate)) {
      return nestedCandidate;
    }
  }

  return undefined;
}

export function copyDefinedEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function mergeNoProxyValue(value?: string): string {
  const requiredHosts = ["127.0.0.1", "localhost", "::1"];
  const merged = new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  for (const host of requiredHosts) {
    merged.add(host);
  }

  return Array.from(merged).join(",");
}

function applyLoopbackNoProxy(env: Record<string, string>): Record<string, string> {
  env.NO_PROXY = mergeNoProxyValue(env.NO_PROXY);
  env.no_proxy = mergeNoProxyValue(env.no_proxy);
  return env;
}

export function resolveDefaultAdapterCommand(
  kind: BridgeAdapterKind,
  options: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  if (kind !== "shell") {
    return kind;
  }

  if (platform === "win32") {
    return "powershell.exe";
  }

  const env = options.env ?? (process.env as Record<string, string | undefined>);
  for (const candidate of DEFAULT_UNIX_SHELL_CANDIDATES) {
    if (resolveCommandPath(candidate, platform, env)) {
      return candidate;
    }
  }

  throw new Error(
    `No default shell executable was found on ${platform}. Tried: ${DEFAULT_UNIX_SHELL_CANDIDATES.join(", ")}. Use --cmd <executable>.`,
  );
}

export function buildCliEnvironment(
  kind: BridgeAdapterKind,
  options: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {},
): Record<string, string> {
  const sourceEnv = options.env ?? (process.env as Record<string, string | undefined>);
  const platform = options.platform ?? process.platform;

  if (kind === "codex" || kind === "claude" || kind === "opencode") {
    // Pass the full environment through on every platform. A previous
    // Windows-only allowlist silently dropped user-configured variables such
    // as ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY, which
    // broke CLIs that authenticate via environment variables even though the
    // same CLI worked when launched manually from the user's shell.
    const env: Record<string, string> = {
      ...copyDefinedEnv(sourceEnv),
      TERM: sourceEnv.TERM || "xterm-256color",
    };

    if (platform === "win32" && !env.HOME && env.USERPROFILE) {
      env.HOME = env.USERPROFILE;
    }

    return applyLoopbackNoProxy(env);
  }

  return {
    ...copyDefinedEnv(sourceEnv),
    TERM: sourceEnv.TERM || "xterm-256color",
  };
}

// ConPTY shipped in Windows 10 build 18309; on older builds node-pty must be
// left to auto-select its winpty fallback instead of being forced onto ConPTY.
export const WINDOWS_CONPTY_MIN_BUILD = 18309;

export function windowsBuildSupportsConpty(osRelease: string): boolean {
  const build = Number(osRelease.split(".")[2]);
  return Number.isFinite(build) && build >= WINDOWS_CONPTY_MIN_BUILD;
}

export function buildPtySpawnOptions(params: {
  cwd: string;
  env: Record<string, string>;
  platform?: NodeJS.Platform;
  osRelease?: string;
}): Parameters<typeof spawnPty>[2] {
  const options: Parameters<typeof spawnPty>[2] = {
    name: "xterm-color",
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: params.cwd,
    env: params.env,
  };

  if (
    (params.platform ?? process.platform) === "win32" &&
    windowsBuildSupportsConpty(params.osRelease ?? os.release())
  ) {
    (options as Parameters<typeof spawnPty>[2] & { useConpty?: boolean }).useConpty = true;
  }

  return options;
}

export function normalizeShellCommandName(command: string): string {
  return path.parse(path.basename(command)).name.toLowerCase();
}

export function resolveShellRuntime(
  command: string,
  options: {
    platform?: NodeJS.Platform;
  } = {},
): ShellRuntime {
  const platform = options.platform ?? process.platform;
  const name = normalizeShellCommandName(command);

  if (name === "powershell" || name === "pwsh") {
    return {
      family: "powershell",
      launchArgs:
        platform === "win32"
          ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit"]
          : ["-NoLogo", "-NoProfile", "-NoExit"],
    };
  }

  if (POSIX_SHELL_NAMES.has(name)) {
    return {
      family: "posix",
      launchArgs: ["-i"],
    };
  }

  throw new Error(
    `Unsupported shell executable for shell adapter: ${command}. Supported shells: powershell, pwsh, bash, zsh, sh, dash, ksh.`,
  );
}

export function escapePowerShellString(text: string): string {
  return text.replace(/`/g, "``").replace(/"/g, '`"');
}

export function escapePosixShellString(text: string): string {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function buildShellProfileCommand(
  profilePath: string,
  family: ShellRuntimeFamily,
): string {
  const resolved = path.resolve(profilePath);
  if (family === "powershell") {
    return `. "${escapePowerShellString(resolved)}"`;
  }
  return `. ${escapePosixShellString(resolved)}`;
}

export function buildShellInputPayload(
  text: string,
  family: ShellRuntimeFamily,
  completionMarker = "__WECHAT_BRIDGE_DONE__",
): string {
  if (family === "powershell") {
    const encodedCommand = Buffer.from(text, "utf8").toString("base64");
    const script = [
      "$__wechatBridgePreviousErrorActionPreference = $ErrorActionPreference",
      "$ErrorActionPreference = 'Continue'",
      "$global:LASTEXITCODE = 0",
      "try {",
      `  $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${escapePowerShellString(encodedCommand)}"))`,
      "  $scriptBlock = [scriptblock]::Create($decoded)",
      "  & $scriptBlock",
      "} catch {",
      "  Write-Error $_",
      "  $global:LASTEXITCODE = 1",
      "} finally {",
      "  if (-not ($global:LASTEXITCODE -is [int])) { $global:LASTEXITCODE = 0 }",
      `  Write-Output "${escapePowerShellString(completionMarker)}:$global:LASTEXITCODE"`,
      "  $ErrorActionPreference = $__wechatBridgePreviousErrorActionPreference",
      "}",
      "",
    ];
    return `${script.join("\r")}\r`;
  }

  const script = [
    text,
    "__wechat_bridge_status=$?",
    `printf '%s:%s\\n' ${escapePosixShellString(completionMarker)} "$__wechat_bridge_status"`,
    "",
  ];
  return `${script.join("\r")}\r`;
}

export async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, CODEX_APP_SERVER_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local app-server port.")));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function waitForTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.setTimeout(500);
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out waiting for app-server on ${host}:${port}.`);
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function appendBoundedLog(existing: string, chunk: string): string {
  const next = existing ? `${existing}${chunk}` : chunk;
  if (next.length <= CODEX_APP_SERVER_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - CODEX_APP_SERVER_LOG_LIMIT);
}

export function normalizeComparablePath(filePath: string): string {
  return path.resolve(filePath).replace(/\//g, "\\").toLowerCase();
}

export function buildCodexSessionDayPath(date: Date): string | null {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME;
  if (!homeDirectory) {
    return null;
  }

  return path.join(
    homeDirectory,
    ".codex",
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
}

export function buildCodexSessionsRoot(): string | null {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME;
  if (!homeDirectory) {
    return null;
  }

  return path.join(homeDirectory, ".codex", "sessions");
}

export function listCodexSessionFilesRecursively(rootDirectory: string): string[] {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const files: string[] = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

export function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  try {
    const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: CodexSessionMeta;
    };
    if (parsed.type !== "session_meta" || !parsed.payload) {
      return null;
    }

    return parsed.payload;
  } catch {
    return null;
  }
}

export function getCodexSessionSource(meta: CodexSessionMeta | null | undefined): string | null {
  if (!meta) {
    return null;
  }

  if (typeof meta.source === "string") {
    return meta.source;
  }

  if (isRecord(meta.source) && typeof meta.source.custom === "string") {
    return meta.source.custom;
  }

  return null;
}

export function isTrustedCodexFallbackSession(meta: CodexSessionMeta | null | undefined): boolean {
  const sessionSource = getCodexSessionSource(meta);
  if (!sessionSource) {
    return false;
  }

  if (sessionSource === "cli") {
    return true;
  }

  const originator = normalizeOutput(meta?.originator ?? "").trim().toLowerCase();
  return sessionSource === "vscode" && originator === "wechat-bridge";
}

export function parseCodexSessionUserMessage(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      payload?: {
        type?: string;
        message?: string;
      };
    };
    if (parsed.type !== "event_msg" || parsed.payload?.type !== "user_message") {
      return null;
    }

    const message =
      typeof parsed.payload.message === "string"
        ? normalizeOutput(parsed.payload.message).trim()
        : "";
    return message || null;
  } catch {
    return null;
  }
}

export function summarizeCodexSessionFile(filePath: string): CodexSessionSummary | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  const meta = readCodexSessionMeta(filePath);
  if (!meta?.id || !meta.cwd) {
    return null;
  }

  let lastTimestamp = meta.timestamp ?? null;
  let lastUserMessage: string | null = null;
  for (const line of lines) {
    const parsedUserMessage = parseCodexSessionUserMessage(line);
    if (parsedUserMessage) {
      lastUserMessage = parsedUserMessage;
    }

    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      if (typeof parsed.timestamp === "string") {
        lastTimestamp = parsed.timestamp;
      }
    } catch {
      // Ignore malformed lines while summarizing persisted sessions.
    }
  }

  const stats = fs.statSync(filePath);
  const lastUpdatedAt =
    lastTimestamp && Number.isFinite(Date.parse(lastTimestamp))
      ? lastTimestamp
      : new Date(stats.mtimeMs).toISOString();

  return {
    threadId: meta.id,
    title: truncatePreview(lastUserMessage ?? meta.id, 120),
    lastUpdatedAt,
    source: getCodexSessionSource(meta) ?? undefined,
    filePath,
  };
}

export function matchesCodexSessionMeta(
  meta: CodexSessionMeta | null | undefined,
  options: {
    cwd: string;
    startedAtMs: number;
    threadId?: string;
    sessionSource?: string;
  },
): boolean {
  if (!meta?.cwd || !meta.id) {
    return false;
  }

  if (normalizeComparablePath(meta.cwd) !== normalizeComparablePath(options.cwd)) {
    return false;
  }

  if (options.threadId && meta.id !== options.threadId) {
    return false;
  }

  const sessionSource = getCodexSessionSource(meta);
  if (options.sessionSource && sessionSource !== options.sessionSource) {
    return false;
  }

  if (options.threadId) {
    return true;
  }

  const sessionStartedAtMs = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
  if (
    Number.isFinite(sessionStartedAtMs) &&
    sessionStartedAtMs < options.startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS
  ) {
    return false;
  }

  return true;
}

export function findCodexSessionFile(
  cwd: string,
  startedAtMs: number,
  options: {
    threadId?: string;
    sessionSource?: string;
  } = {},
): string | null {
  if (options.threadId) {
    const sessionsRoot = buildCodexSessionsRoot();
    if (!sessionsRoot) {
      return null;
    }

    const candidates = listCodexSessionFilesRecursively(sessionsRoot)
      .map((filePath) => {
        const meta = readCodexSessionMeta(filePath);
        if (!matchesCodexSessionMeta(meta, { cwd, startedAtMs, ...options })) {
          return null;
        }

        const stats = fs.statSync(filePath);
        return {
          filePath,
          modifiedAtMs: stats.mtimeMs,
        };
      })
      .filter((candidate): candidate is { filePath: string; modifiedAtMs: number } => Boolean(candidate))
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.filePath ?? null;
  }

  const dayDirectories = [new Date(), new Date(startedAtMs), new Date(startedAtMs - 86_400_000)]
    .map(buildCodexSessionDayPath)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((directory) => fs.existsSync(directory));

  const candidates: Array<{
    filePath: string;
    modifiedAtMs: number;
    sessionStartedAtMs: number;
  }> = [];

  for (const directory of dayDirectories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(directory, entry.name);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS) {
        continue;
      }

      const meta = readCodexSessionMeta(filePath);
      if (!matchesCodexSessionMeta(meta, { cwd, startedAtMs, ...options })) {
        continue;
      }

      const sessionStartedAtMs = meta?.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
      candidates.push({
        filePath,
        modifiedAtMs: stats.mtimeMs,
        sessionStartedAtMs,
      });
    }
  }

  candidates.sort((left, right) => {
    const leftDistance = Number.isFinite(left.sessionStartedAtMs)
      ? Math.abs(left.sessionStartedAtMs - startedAtMs)
      : Number.POSITIVE_INFINITY;
    const rightDistance = Number.isFinite(right.sessionStartedAtMs)
      ? Math.abs(right.sessionStartedAtMs - startedAtMs)
      : Number.POSITIVE_INFINITY;

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return right.modifiedAtMs - left.modifiedAtMs;
  });

  return candidates[0]?.filePath ?? null;
}

export function findRecentCodexSessionFileForCwd(
  cwd: string,
  startedAtMs: number,
): CodexRecentSessionFile | null {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot) {
    return null;
  }

  const currentCwd = normalizeComparablePath(cwd);
  let bestCandidate: CodexRecentSessionFile | null = null;

  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const meta = readCodexSessionMeta(filePath);
    if (!meta?.id || !meta.cwd || normalizeComparablePath(meta.cwd) !== currentCwd) {
      continue;
    }

    if (!isTrustedCodexFallbackSession(meta)) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (stats.mtimeMs < startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS) {
      continue;
    }

    if (!bestCandidate || stats.mtimeMs > bestCandidate.modifiedAtMs) {
      bestCandidate = {
        threadId: meta.id,
        filePath,
        modifiedAtMs: stats.mtimeMs,
      };
    }
  }

  return bestCandidate;
}

export function listCodexResumeSessions(
  cwd: string,
  limit = 10,
): BridgeResumeSessionCandidate[] {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot) {
    return [];
  }

  const currentCwd = normalizeComparablePath(cwd);
  const newestByThreadId = new Map<string, CodexSessionSummary>();
  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const summary = summarizeCodexSessionFile(filePath);
    if (!summary) {
      continue;
    }

    const meta = readCodexSessionMeta(filePath);
    if (!meta?.cwd || normalizeComparablePath(meta.cwd) !== currentCwd) {
      continue;
    }

    const previous = newestByThreadId.get(summary.threadId);
    if (!previous || Date.parse(summary.lastUpdatedAt) > Date.parse(previous.lastUpdatedAt)) {
      newestByThreadId.set(summary.threadId, summary);
    }
  }

  return Array.from(newestByThreadId.values())
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit))
    .map((summary) => ({
      sessionId: summary.threadId,
      threadId: summary.threadId,
      title: summary.title,
      lastUpdatedAt: summary.lastUpdatedAt,
      source: summary.source,
    }));
}

export function listCodexResumeThreads(
  cwd: string,
  limit = 10,
): BridgeResumeThreadCandidate[] {
  return listCodexResumeSessions(cwd, limit);
}

export function resolveSpawnTarget(
  command: string,
  kind: BridgeAdapterKind,
  options: ResolveSpawnTargetOptions = {},
): SpawnTarget {
  const trimmed = command.trim();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const forwardArgs = options.forwardArgs ?? [];

  if (!trimmed) {
    return { file: trimmed, args: [...forwardArgs] };
  }

  const resolved = resolveCommandPath(trimmed, platform, env) ?? trimmed;
  if (platform !== "win32" || (kind !== "codex" && kind !== "claude" && kind !== "opencode")) {
    return { file: resolved, args: [...forwardArgs] };
  }

  const bundledExe =
    kind === "codex" || kind === "claude"
      ? resolveBundledWindowsExe(kind, resolved)
      : undefined;
  if (bundledExe) {
    return { file: bundledExe, args: [...forwardArgs] };
  }

  const extension = path.extname(resolved).toLowerCase();
  if (WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.includes(extension)) {
    if (extension === ".cmd" || extension === ".bat") {
      return wrapWithCmdExe(resolved, forwardArgs, env);
    }
    return { file: resolved, args: [...forwardArgs] };
  }

  if (extension === WINDOWS_POWERSHELL_EXTENSION) {
    const siblingCmd = resolved.slice(0, -extension.length) + ".cmd";
    if (fileExists(siblingCmd)) {
      return wrapWithCmdExe(siblingCmd, forwardArgs, env);
    }
  }

  return { file: resolved, args: [...forwardArgs] };
}

export type PtyLike = {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  resize?(cols: number, rows: number): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

export function spawnFallbackProcess(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): PtyLike {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...options.env, TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
    shell: false,
  });

  if (!child.pid) {
    throw new Error(`Failed to spawn fallback process: ${file}`);
  }

  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const listener of dataListeners) {
      listener(text);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const listener of dataListeners) {
      listener(text);
    }
  });

  child.on("exit", (code, signal) => {
    const exitCode = code ?? (signal ? 128 : 1);
    for (const listener of exitListeners) {
      listener({ exitCode });
    }
  });

  // spawn itself failed (e.g. ENOENT/EACCES) — surface as an exit so callers
  // stop waiting, instead of throwing an unhandled "error" event that would
  // crash the bridge on the PTY fallback path.
  child.on("error", () => {
    for (const listener of exitListeners) {
      listener({ exitCode: 1 });
    }
  });

  // Swallow broken-pipe errors on stdin writes after the child has exited.
  child.stdin?.on("error", () => {
    /* best effort */
  });

  return {
    pid: child.pid,
    write(data: string) {
      child.stdin?.write(data);
    },
    kill(signal?: string) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          child.kill(signal as NodeJS.Signals | undefined);
        }
      } catch {
        // Best effort.
      }
    },
    onData(callback: (data: string) => void) {
      dataListeners.push(callback);
      return {
        dispose() {
          const index = dataListeners.indexOf(callback);
          if (index >= 0) dataListeners.splice(index, 1);
        },
      };
    },
    onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
      exitListeners.push(callback);
      return {
        dispose() {
          const index = exitListeners.indexOf(callback);
          if (index >= 0) exitListeners.splice(index, 1);
        },
      };
    },
  };
}

export function buildSpawnDiagnostic(
  error: unknown,
  spawnTarget: SpawnTarget | null,
  platform: NodeJS.Platform = process.platform,
): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const target = spawnTarget ? spawnTarget.file : "(unknown)";

  const lines: string[] = [
    t("spawn.diagnostic.title", { target, error: errorMessage }),
    t("spawn.diagnostic.fixesHeader"),
  ];

  if (errorMessage.includes("posix_spawnp") || errorMessage.includes("node-pty")) {
    lines.push(t("spawn.diagnostic.nodePty"));
    if (platform === "darwin") {
      lines.push(t("spawn.diagnostic.xcode"));
    }
    if (platform === "linux") {
      lines.push(t("spawn.diagnostic.linuxBuildTools"));
    }
  } else if (errorMessage.includes("ENOENT") || errorMessage.includes("spawn")) {
    lines.push(t("spawn.diagnostic.notFound", { target }));
  } else {
    lines.push(t("spawn.diagnostic.generic"));
  }

  lines.push(t("spawn.diagnostic.nodeVersion"));
  if (platform === "win32") {
    lines.push(t("spawn.diagnostic.winFull"));
  }

  return lines.join("\n");
}
