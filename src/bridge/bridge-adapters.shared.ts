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
  SpawnTarget,
  UserInputRequest,
} from "./bridge-types.ts";
import {
  WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE,
  containsWechatOutboundAttachmentPath,
  containsWechatOutboundAttachmentPathDeep,
  detectCliApproval,
  isWechatOutboundAttachmentWriteCommand,
  isHighRiskShellCommand,
  isStrictApprovalModeEnabled,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";
import {
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
  initialSharedSessionId?: string;
  initialSharedThreadId?: string;
  initialResumeConversationId?: string;
  initialTranscriptPath?: string;
  lifecycleMode?: BridgeLifecycleMode;
  sessionStartMode?: BridgeSessionStartMode;
};

export type EventSink = (event: BridgeEvent) => void;

export type ResolveSpawnTargetOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
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

export type CodexPendingThreadAnnouncement = {
  threadId: string;
  source: string;
  lastUpdatedAt: string;
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
  toolName?: string;
  socket: net.Socket;
  timer: ReturnType<typeof setTimeout>;
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
export const CODEX_APP_SERVER_RPC_TIMEOUT_MS = 25_000;
export const CODEX_APP_SERVER_LOG_LIMIT = 12_000;
export const CODEX_RPC_CONNECT_RETRY_MS = 150;
export const CODEX_RPC_RECONNECT_TIMEOUT_MS = 5_000;
export const CLAUDE_HOOK_APPROVAL_TIMEOUT_MS = 120_000;
export const LOCAL_COMPANION_RECONNECT_GRACE_MS = 15_000;
export const CLAUDE_HOOK_LISTEN_HOST = "127.0.0.1";
export const CLAUDE_HELP_PROBE_TIMEOUT_MS = 5_000;
export const CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS = 12_000;
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
export const DEFAULT_UNIX_SHELL_CANDIDATES = ["pwsh", "bash", "zsh", "sh"] as const;
export const POSIX_SHELL_NAMES = new Set(["bash", "zsh", "sh", "dash", "ksh"]);
export const CLAUDE_FLAG_SUPPORT_CACHE = new Map<string, boolean>();

export type ShellRuntimeFamily = "powershell" | "posix";

export type ShellRuntime = {
  family: ShellRuntimeFamily;
  launchArgs: string[];
};

export function buildLocalCompanionToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildCodexCliArgs(options: {
  remoteUrl: string;
  resumeThreadId?: string | null;
  profile?: string;
  inlineMode?: boolean;
}): string[] {
  const remoteUrl = options.remoteUrl.replace(/^http:\/\//, "ws://");
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

  return args;
}

export function hasClaudeNoAltScreenOption(helpText: string): boolean {
  return helpText.includes("--no-alt-screen");
}

export function buildClaudeCliArgs(options: {
  settingsFilePath: string;
  resumeConversationId?: string | null;
  profile?: string;
  includeNoAltScreen?: boolean;
}): string[] {
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

  return args;
}

export function assertNoReservedExtraCliArgs(
  extraArgs: string[],
  reservedOptions: string[],
  kind: BridgeAdapterKind,
): void {
  for (const arg of extraArgs) {
    const matched = reservedOptions.find(
      (reserved) => arg === reserved || arg.startsWith(`${reserved}=`),
    );
    if (matched) {
      throw new Error(
        `The ${matched} option is managed by the ${kind} bridge and cannot be passed as an extra CLI argument.`,
      );
    }
  }
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
  const cacheKey = command.trim() || "claude";
  const cached = CLAUDE_FLAG_SUPPORT_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = spawnSync(command, ["--help"], {
      encoding: "utf8",
      shell: true,
      windowsHide: true,
      timeout: CLAUDE_HELP_PROBE_TIMEOUT_MS,
    });
    const supported =
      result.status === 0 &&
      typeof result.stdout === "string" &&
      hasClaudeNoAltScreenOption(result.stdout);
    CLAUDE_FLAG_SUPPORT_CACHE.set(cacheKey, supported);
    return supported;
  } catch {
    CLAUDE_FLAG_SUPPORT_CACHE.set(cacheKey, false);
    return false;
  }
}

export function buildCodexApprovalRequest(
  method: CodexPendingApprovalRequest["method"],
  params: Record<string, unknown>,
): ApprovalRequest | null {
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
        ? `Codex needs approval before running: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before running a command.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const reason = typeof params.reason === "string" ? params.reason : "";
    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before applying file changes: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before applying file changes.",
      commandPreview: "File modification approval requested.",
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
  params: Record<string, unknown>,
): string | null {
  if (!containsWechatOutboundAttachmentPath(JSON.stringify(params))) {
    return null;
  }

  if (method === "item/commandExecution/requestApproval") {
    return isWechatOutboundAttachmentWriteCommand(params.command) ||
      containsWechatOutboundAttachmentPathDeep(params.additionalPermissions)
      ? WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE
      : null;
  }

  if (method === "item/fileChange/requestApproval") {
    return containsWechatOutboundAttachmentPathDeep(params.grantRoot)
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
): CodexApprovalAutoResponse | null {
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
      if (options.strictAutoReview === true && Array.isArray(fileSystem.write)) {
        const safeWritePaths = fileSystem.write.filter(
          (pathValue) => typeof pathValue === "string" && !isHighRiskPermissionPath(pathValue),
        );
        fileSystem.write = safeWritePaths;
      }
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
  if (!isRecord(params)) {
    return null;
  }

  const prompt = typeof params.prompt === "string" && params.prompt.trim() ? params.prompt.trim() : null;
  const questions = Array.isArray(params.questions)
    ? params.questions
        .map((question) => {
          if (!isRecord(question)) {
            return null;
          }

          const id = typeof question.id === "string" && question.id.trim() ? question.id.trim() : "";
          const text =
            typeof question.text === "string" && question.text.trim()
              ? question.text.trim()
              : typeof question.prompt === "string" && question.prompt.trim()
                ? question.prompt.trim()
                : "";
          if (!id || !text) {
            return null;
          }

          const header =
            typeof question.header === "string" && question.header.trim()
              ? question.header.trim()
              : undefined;
          const options = Array.isArray(question.options)
            ? question.options
                .map((option) => {
                  if (!isRecord(option)) {
                    return null;
                  }
                  const label =
                    typeof option.label === "string" && option.label.trim()
                      ? option.label.trim()
                      : "";
                  const description =
                    typeof option.description === "string" && option.description.trim()
                      ? option.description.trim()
                      : undefined;
                  if (!label) {
                    return null;
                  }
                  return {
                    label,
                    description,
                  };
                })
                .filter((option): option is NonNullable<typeof option> => Boolean(option))
            : null;

          return {
            id,
            text,
            header,
            options: options && options.length > 0 ? options : undefined,
          };
        })
        .filter((question): question is NonNullable<typeof question> => Boolean(question))
    : [];

  if (!prompt && questions.length === 0) {
    return null;
  }

  return {
    prompt: prompt ?? "Codex is waiting for your answer.",
    questions,
  };
}

export function extractCodexFinalTextFromItem(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "assistantMessage") {
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
  kind: Extract<BridgeAdapterKind, "codex" | "claude" | "opencode">,
  launcherPath: string,
): string | undefined {
  const launcherDirectory = path.dirname(launcherPath);

  if (kind === "opencode") {
    const opencodeCandidates = [
      path.join(launcherDirectory, "node_modules", "opencode-ai", "bin", "opencode.exe"),
      path.join(launcherDirectory, "node_modules", "opencode", "bin", "opencode.exe"),
      path.join(launcherDirectory, "node_modules", "@opencode-ai", "sdk", "bin", "opencode.exe"),
      path.join(launcherDirectory, "..", "opencode-ai", "bin", "opencode.exe"),
      path.join(launcherDirectory, "..", "opencode", "bin", "opencode.exe"),
      path.join(launcherDirectory, "..", "@opencode-ai", "sdk", "bin", "opencode.exe"),
    ];
    for (const candidate of opencodeCandidates) {
      if (fileExists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

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

function applyLoopbackNoProxy(env: Record<string, string>): Record<string, string> {
  const noProxyKeys = ["NO_PROXY", "no_proxy"] as const;
  const loopbackHosts = ["127.0.0.1", "localhost"];
  const existingKey = noProxyKeys.find((key) => typeof env[key] === "string");
  const targetKey = existingKey ?? "NO_PROXY";
  const existingValue = env[targetKey]?.trim() ?? "";
  const existingEntries = existingValue
    ? existingValue
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

  const mergedEntries = [...existingEntries];
  for (const host of loopbackHosts) {
    if (!mergedEntries.includes(host)) {
      mergedEntries.push(host);
    }
  }

  return {
    ...env,
    [targetKey]: mergedEntries.join(","),
  };
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
  const env = copyDefinedEnv(sourceEnv);

  env.CLI_BRIDGE_ACTIVE = "1";
  env.CLI_BRIDGE_ADAPTER = kind;
  env.CLI_BRIDGE_PLATFORM = options.platform ?? process.platform;
  env.NODE_ENV = env.NODE_ENV ?? "production";

  if (isStrictApprovalModeEnabled(sourceEnv)) {
    env.CLI_BRIDGE_STRICT_APPROVAL = "1";
  }

  return applyLoopbackNoProxy(env);
}

export function buildPtySpawnOptions(params: {
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}): {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
} {
  const options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  } = {
    name: "xterm-256color",
    cols: params.cols ?? DEFAULT_COLS,
    rows: params.rows ?? DEFAULT_ROWS,
    cwd: params.cwd,
    env: params.env,
  };

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
          ? ["-NoLogo", "-NoExit", "-Command", "-"]
          : ["-NoLogo", "-NoExit", "-Command", "-"],
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
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
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
  marker: string,
): string {
  const normalized = text.replace(/\r?\n/g, "\n");
  if (family === "powershell") {
    return `${normalized}\r\nWrite-Output "${marker}"\r\n`;
  }
  return `${normalized}\nprintf '%s\\n' "${marker}"\n`;
}

export function appendBoundedLog(existing: string, chunk: string): string {
  const next = `${existing}${chunk}`;
  if (next.length <= CODEX_APP_SERVER_LOG_LIMIT) {
    return next;
  }

  return next.slice(-CODEX_APP_SERVER_LOG_LIMIT);
}

export async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, CODEX_APP_SERVER_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local TCP port.")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function waitForTcpPort(
  port: number,
  host: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out waiting for TCP port ${host}:${port} after ${timeoutMs}ms.`);
}

export function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath).toLowerCase();
  return process.platform === "win32" ? normalized.replace(/\\/g, "/") : normalized;
}

export function buildCodexSessionDayPath(date: Date): string | null {
  const homeDirectory = process.env.HOME || process.env.USERPROFILE;
  if (!homeDirectory) {
    return null;
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(homeDirectory, ".codex", "sessions", year, month, day);
}

export function buildCodexSessionsRoot(): string | null {
  const homeDirectory = process.env.HOME || process.env.USERPROFILE;
  if (!homeDirectory) {
    return null;
  }

  return path.join(homeDirectory, ".codex", "sessions");
}

export function listCodexSessionFilesRecursively(rootDirectory: string): string[] {
  if (!fs.existsSync(rootDirectory)) {
    return [];
  }

  const results: string[] = [];
  const entries = fs.readdirSync(rootDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      results.push(...listCodexSessionFilesRecursively(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }

  return results;
}

export function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  try {
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(16_384);
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) {
        return null;
      }

      const text = buffer.toString("utf8", 0, bytesRead);
      const firstLine = text.split(/\r?\n/)[0];
      if (!firstLine) {
        return null;
      }

      const event = JSON.parse(firstLine) as {
        type?: string;
        payload?: CodexSessionMeta;
      };
      if (event.type !== "session_meta" || !event.payload || typeof event.payload !== "object") {
        return null;
      }

      return event.payload;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

export function getCodexSessionSource(meta: CodexSessionMeta | null | undefined): string | null {
  if (!meta) {
    return null;
  }

  if (typeof meta.source === "string" && meta.source.trim()) {
    return meta.source.trim().toLowerCase();
  }

  if (isRecord(meta.source) && typeof meta.source.custom === "string" && meta.source.custom.trim()) {
    return meta.source.custom.trim().toLowerCase();
  }

  if (typeof meta.originator === "string" && meta.originator.trim()) {
    return meta.originator.trim().toLowerCase();
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
    const event = JSON.parse(trimmed) as {
      type?: string;
      payload?: unknown;
    };
    if (event.type !== "user_message" && event.type !== "userMessage") {
      return null;
    }

    return extractCodexUserMessageText(event.payload);
  } catch {
    return null;
  }
}

export function summarizeCodexSessionFile(filePath: string): CodexSessionSummary | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      return null;
    }

    const firstLine = lines[0];
    const event = JSON.parse(firstLine) as {
      type?: string;
      payload?: CodexSessionMeta;
    };
    if (event.type !== "session_meta" || !event.payload?.id) {
      return null;
    }

    let title = event.payload.id;
    for (let index = 1; index < lines.length; index++) {
      const candidateText = parseCodexSessionUserMessage(lines[index]);
      if (candidateText) {
        title = candidateText;
        break;
      }
    }

    const stat = fs.statSync(filePath);
    return {
      threadId: event.payload.id,
      title,
      lastUpdatedAt: stat.mtime.toISOString(),
      source: event.payload.source
        ? typeof event.payload.source === "string"
          ? event.payload.source
          : event.payload.source.custom
        : undefined,
      filePath,
    };
  } catch {
    return null;
  }
}

export function matchesCodexSessionMeta(
  meta: CodexSessionMeta | null | undefined,
  targetCwd: string,
  nowMs: number,
  matchWindowMs: number,
): boolean {
  if (!meta?.id || !meta.cwd) {
    return false;
  }

  if (normalizeComparablePath(meta.cwd) !== targetCwd) {
    return false;
  }

  if (!isTrustedCodexFallbackSession(meta)) {
    return false;
  }

  if (!meta.timestamp) {
    return true;
  }

  const sessionCreatedAtMs = Date.parse(meta.timestamp);
  if (!Number.isFinite(sessionCreatedAtMs)) {
    return true;
  }

  return nowMs - sessionCreatedAtMs <= matchWindowMs;
}

export function findCodexSessionFile(
  threadId: string,
  cwd?: string,
): string | null {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot) {
    return null;
  }

  const currentCwd = cwd ? normalizeComparablePath(cwd) : null;
  let fallbackPath: string | null = null;
  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const meta = readCodexSessionMeta(filePath);
    if (meta?.id !== threadId) {
      continue;
    }

    if (!currentCwd || !meta.cwd || normalizeComparablePath(meta.cwd) === currentCwd) {
      return filePath;
    }

    fallbackPath = fallbackPath ?? filePath;
  }

  return fallbackPath;
}

export function findRecentCodexSessionFileForCwd(
  cwd: string,
  options: {
    nowMs?: number;
    matchWindowMs?: number;
  } = {},
): CodexRecentSessionFile | null {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot) {
    return null;
  }

  const targetCwd = normalizeComparablePath(cwd);
  const nowMs = options.nowMs ?? Date.now();
  const matchWindowMs = options.matchWindowMs ?? CODEX_SESSION_MATCH_WINDOW_MS;
  let bestCandidate: CodexRecentSessionFile | null = null;

  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const meta = readCodexSessionMeta(filePath);
    if (!matchesCodexSessionMeta(meta, targetCwd, nowMs, matchWindowMs) || !meta?.id) {
      continue;
    }

    const stats = fs.statSync(filePath);
    if (nowMs - stats.mtimeMs > matchWindowMs) {
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
    .sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt))
    .slice(0, limit)
    .map((item) => ({
      sessionId: item.threadId,
      threadId: item.threadId,
      preview: truncatePreview(item.title, 120),
      createdAt: undefined,
      lastActivityAt: isRecentIsoTimestamp(item.lastUpdatedAt)
        ? item.lastUpdatedAt
        : undefined,
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
    kind === "codex" || kind === "claude" || kind === "opencode"
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

  child.on("error", (err) => {
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
    t("spawn.diagnostic.failed", { target }),
    t("spawn.diagnostic.error", { error: errorMessage }),
    "",
    t("spawn.diagnostic.possibleFixes"),
  ];

  if (errorMessage.includes("posix_spawnp") || errorMessage.includes("node-pty")) {
    lines.push(
      t("spawn.diagnostic.nodePtyIncompatible"),
      t("spawn.diagnostic.rebuildNodePty"),
      t("spawn.diagnostic.reinstallLatest"),
    );
    if (platform === "darwin") {
      lines.push(t("spawn.diagnostic.ensureXcodeCli"));
    }
  } else if (errorMessage.includes("ENOENT") || errorMessage.includes("spawn")) {
    lines.push(
      t("spawn.diagnostic.commandNotFound", { target }),
      t("spawn.diagnostic.verifyInstalled"),
    );
  } else {
    lines.push(t("spawn.diagnostic.reinstallLatest"));
  }

  if (platform === "win32") {
    lines.push(t("spawn.diagnostic.winFull"));
  }

  return lines.join("\n");
}
