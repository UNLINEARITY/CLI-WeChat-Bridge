// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { NativeTerminalControl, readClaudePermissionMode } from "./native-terminal-control.ts";
import { ClaudeNativeControls } from "./claude-native-controls.ts";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildLocalCompanionToken } from "../companion/local-companion-link.ts";
import { t } from "../i18n/index.ts";
import { getInstalledPackageName } from "../utils/version-checker.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  buildClaudeFailureMessage,
  buildClaudeHookScript,
  buildClaudeHookSettings,
  buildClaudeUserInputRequest,
  buildClaudeUserInputHookOutput,
  buildClaudePermissionDecisionHookOutput,
  buildClaudePermissionApprovalRequest,
  extractClaudeAssistantMessageText,
  extractClaudeResumeConversationId,
  extractClaudeTranscriptFinalReply,
  findInjectedClaudePromptIndex,
  getClaudePermissionAutoResponse,
  getClaudeToolCallKey,
  getClaudeOutboundAttachmentDenyMessage,
  normalizeClaudeAssistantMessage,
  parseClaudeHookPayload,
  type ClaudeHookPayload,
  type PendingInjectedClaudePrompt,
} from "./claude-hooks.ts";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolveOptions,
  BridgeNoticeLevel,
  BridgeModelOption,
  BridgeResumeSessionCandidate,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  BridgeTurnOrigin,
  UserInputRequest,
} from "./bridge-types.ts";
import { detectCliApproval } from "./approval-detection.ts";
import { normalizeOutput, nowIso, truncatePreview } from "../core/text-utils.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import * as shared from "./bridge-adapters.shared.ts";

type AdapterOptions = shared.AdapterOptions;
type ClaudePendingHookApproval = shared.ClaudePendingHookApproval;

const {
  CLAUDE_HOOK_LISTEN_HOST,
  CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MODULE_DIR,
  buildClaudeCliArgs,
  delay,
  isClaudeInvalidResumeError,
  quotePosixCommandArg,
  quoteWindowsCommandArg,
  shouldIncludeClaudeNoAltScreen,
} = shared;

const CLAUDE_COMPACT_OUTPUT_LINE_RE =
  /^Compacted(?:\s*\(.*full summary.*\))?$/i;
const CLAUDE_COMPACT_FAILURE_RE =
  /Error:\s*Error during compaction:|(?:^|\b)API Error:|\b(?:compact|compaction)\s+failed\b|^Error:/i;
const CLAUDE_COMPACT_DEDUP_MS = 2_000;
const CLAUDE_BRACKETED_PASTE_START = "\u001b[200~";
const CLAUDE_BRACKETED_PASTE_END = "\u001b[201~";
const CLAUDE_REMOTE_ENTER_DELAY_MS = 40;
const CLAUDE_REMOTE_ENTER_RETRY_DELAYS_MS = [200, 500, 1_000] as const;
const CLAUDE_INTERACTIVE_READY_TIMEOUT_MS = 10_000;
const CLAUDE_STARTUP_OUTPUT_BUFFER_LIMIT = 4_000;
const CLAUDE_SESSION_METADATA_READ_BYTES = 64 * 1024;
const CLAUDE_MAX_SANITIZED_PROJECT_PATH = 200;
const CLAUDE_RESUME_TIMEOUT_MS = 30_000;
const CLAUDE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ClaudeSessionIndexEntry = {
  sessionId?: string;
  fullPath?: string;
  firstPrompt?: string;
  created?: string;
  modified?: string;
  projectPath?: string;
  isSidechain?: boolean;
  customTitle?: string;
  summary?: string;
};

type ClaudeSessionMetadata = {
  cwd?: string;
  isSidechain?: boolean;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  summary?: string;
  firstPrompt?: string;
  lastTimestampMs: number;
};

type ClaudePendingResume = {
  targetConversationId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionEndObserved: boolean;
};

type ClaudeInteractiveReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function isClaudeWorkspaceTrustPrompt(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  return (
    /Accessing workspace:/i.test(compact) &&
    /Quick safety check:/i.test(compact) &&
    /project you created or one you trust/i.test(compact) &&
    /I trust this folder/i.test(compact)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameClaudePath(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function getClaudeConfigDirectory(
  env: Record<string, string | undefined>,
): string {
  const custom = env.CLAUDE_CONFIG_DIR;
  return custom
    ? path.resolve(expandHomePath(custom))
    : path.join(env.USERPROFILE || env.HOME || os.homedir(), ".claude");
}

function sanitizeClaudeProjectPath(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

export function buildClaudeProjectSessionDirectory(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(
    getClaudeConfigDirectory(env),
    "projects",
    sanitizeClaudeProjectPath(cwd),
  );
}

function readClaudeSessionSegments(filePath: string): string[] {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const headLength = Math.min(stat.size, CLAUDE_SESSION_METADATA_READ_BYTES);
    const headBuffer = Buffer.alloc(headLength);
    fs.readSync(fd, headBuffer, 0, headLength, 0);
    const tailStart = Math.max(0, stat.size - CLAUDE_SESSION_METADATA_READ_BYTES);
    const tailLength = stat.size - tailStart;
    const tailBuffer = Buffer.alloc(tailLength);
    fs.readSync(fd, tailBuffer, 0, tailLength, tailStart);
    return [headBuffer.toString("utf8"), tailBuffer.toString("utf8")];
  } finally {
    fs.closeSync(fd);
  }
}

function extractClaudeUserMessageText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeOutput(value).trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return normalizeOutput(
    value
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n"),
  ).trim();
}

function readClaudeSessionMetadata(filePath: string): ClaudeSessionMetadata {
  const metadata: ClaudeSessionMetadata = { lastTimestampMs: 0 };
  const seenLines = new Set<string>();
  for (const segment of readClaudeSessionSegments(filePath)) {
    for (const rawLine of segment.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || seenLines.has(line)) {
        continue;
      }
      seenLines.add(line);
      try {
        const entry = JSON.parse(line) as unknown;
        if (!isRecord(entry)) {
          continue;
        }
        if (typeof entry.cwd === "string") {
          metadata.cwd = entry.cwd;
        }
        if (entry.isSidechain === false) {
          metadata.isSidechain = false;
        } else if (entry.isSidechain === true && metadata.isSidechain === undefined) {
          metadata.isSidechain = true;
        }
        if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
          metadata.customTitle = normalizeOutput(entry.customTitle).trim();
        } else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
          metadata.aiTitle = normalizeOutput(entry.aiTitle).trim();
        } else if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string") {
          metadata.lastPrompt = normalizeOutput(entry.lastPrompt).trim();
        } else if (entry.type === "summary" && typeof entry.summary === "string") {
          metadata.summary = normalizeOutput(entry.summary).trim();
        } else if (
          !metadata.firstPrompt &&
          entry.type === "user" &&
          isRecord(entry.message)
        ) {
          metadata.firstPrompt = extractClaudeUserMessageText(entry.message.content);
        }
        if (typeof entry.timestamp === "string") {
          const timestampMs = Date.parse(entry.timestamp);
          if (Number.isFinite(timestampMs)) {
            metadata.lastTimestampMs = Math.max(metadata.lastTimestampMs, timestampMs);
          }
        }
      } catch {
        // Head/tail segments can begin or end with a partial JSONL line.
      }
    }
  }
  return metadata;
}

function readClaudeSessionIndex(
  projectDir: string,
  cwd: string,
): Map<string, ClaudeSessionIndexEntry> {
  const indexPath = path.join(projectDir, "sessions-index.json");
  if (!fs.existsSync(indexPath)) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return new Map();
    }
    if (typeof parsed.originalPath === "string" && !isSameClaudePath(parsed.originalPath, cwd)) {
      return new Map();
    }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return new Map(
      entries
        .filter((entry): entry is ClaudeSessionIndexEntry => isRecord(entry))
        .filter((entry) => typeof entry.sessionId === "string")
        .map((entry) => [entry.sessionId!, entry]),
    );
  } catch {
    return new Map();
  }
}

function findClaudeProjectSessionDirectories(
  cwd: string,
  env: Record<string, string | undefined>,
): string[] {
  const projectsDir = path.join(getClaudeConfigDirectory(env), "projects");
  const direct = buildClaudeProjectSessionDirectory(cwd, env);
  const results = new Set<string>();
  if (fs.existsSync(direct)) {
    results.add(direct);
  }
  const sanitized = sanitizeClaudeProjectPath(cwd);
  if (sanitized.length <= CLAUDE_MAX_SANITIZED_PROJECT_PATH || !fs.existsSync(projectsDir)) {
    return [...results];
  }
  const prefix = sanitized.slice(0, CLAUDE_MAX_SANITIZED_PROJECT_PATH);
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`${prefix}-`)) {
      results.add(path.join(projectsDir, entry.name));
    }
  }
  return [...results];
}

function summarizeClaudeSessionFile(
  filePath: string,
  cwd: string,
  indexEntry?: ClaudeSessionIndexEntry,
): BridgeResumeSessionCandidate | null {
  const sessionId = path.basename(filePath, ".jsonl");
  if (!CLAUDE_SESSION_ID_RE.test(sessionId)) {
    return null;
  }
  try {
    const metadata = readClaudeSessionMetadata(filePath);
    const belongsToCwd =
      (typeof indexEntry?.projectPath === "string" &&
        isSameClaudePath(indexEntry.projectPath, cwd)) ||
      (typeof metadata.cwd === "string" && isSameClaudePath(metadata.cwd, cwd));
    if (!belongsToCwd || indexEntry?.isSidechain === true || metadata.isSidechain === true) {
      return null;
    }
    const indexedModifiedMs =
      typeof indexEntry?.modified === "string" ? Date.parse(indexEntry.modified) : 0;
    const updatedMs =
      metadata.lastTimestampMs ||
      (Number.isFinite(indexedModifiedMs) ? indexedModifiedMs : 0) ||
      fs.statSync(filePath).mtimeMs;
    const title =
      metadata.customTitle ||
      indexEntry?.customTitle ||
      metadata.aiTitle ||
      metadata.lastPrompt ||
      indexEntry?.summary ||
      metadata.summary ||
      indexEntry?.firstPrompt ||
      metadata.firstPrompt;
    if (!title) {
      return null;
    }
    return {
      sessionId,
      title: truncatePreview(title, 120),
      lastUpdatedAt: new Date(updatedMs).toISOString(),
      source: "claude",
    };
  } catch {
    return null;
  }
}

export function listClaudeResumeSessions(
  cwd: string,
  limit = 10,
  env: Record<string, string | undefined> = process.env,
): BridgeResumeSessionCandidate[] {
  const candidates: BridgeResumeSessionCandidate[] = [];
  for (const projectDir of findClaudeProjectSessionDirectories(cwd, env)) {
    const index = readClaudeSessionIndex(projectDir, cwd);
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) {
        continue;
      }
      const sessionId = path.basename(entry.name, ".jsonl");
      const candidate = summarizeClaudeSessionFile(
        path.join(projectDir, entry.name),
        cwd,
        index.get(sessionId),
      );
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  return candidates
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit));
}

function findClaudeResumeSessionFile(
  cwd: string,
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const projectDir of findClaudeProjectSessionDirectories(cwd, env)) {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    if (
      fs.existsSync(filePath) &&
      summarizeClaudeSessionFile(
        filePath,
        cwd,
        readClaudeSessionIndex(projectDir, cwd).get(sessionId),
      )
    ) {
      return filePath;
    }
  }
  return null;
}

export function normalizeClaudeProjectConfigKey(cwd: string): string {
  return path.resolve(cwd).replace(/\\/g, "/");
}

export function ensureClaudeWorkspaceTrustAccepted(
  cwd: string,
  homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(),
): boolean {
  const configPath = path.join(homeDir, ".claude.json");
  let config: Record<string, unknown> = {};

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      config = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
    }
  } catch {
    return false;
  }

  if (!isRecord(config)) {
    return false;
  }

  const projectKey = normalizeClaudeProjectConfigKey(cwd);
  const projects = isRecord(config.projects) ? config.projects : {};
  const currentProject = isRecord(projects[projectKey])
    ? projects[projectKey]
    : {};
  if (currentProject.hasTrustDialogAccepted === true) {
    return false;
  }

  const nextConfig = {
    ...config,
    projects: {
      ...projects,
      [projectKey]: {
        ...currentProject,
        hasTrustDialogAccepted: true,
      },
    },
  };
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, configPath);
    return true;
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    return false;
  }
}

export class ClaudeCompanionAdapter extends AbstractPtyAdapter {
  private hookServer: net.Server | null = null;
  private hookPort: number | null = null;
  private hookToken: string | null = null;
  private runtimeSessionId: string | null;
  private resumeConversationId: string | null;
  private transcriptPath: string | null;
  private pendingCliApprovalHints:
    | Pick<ApprovalRequest, "confirmInput" | "denyInput">
    | null = null;
  private pendingInjectedInputs: PendingInjectedClaudePrompt[] = [];
  private localTerminalInputListener: ((chunk: string | Buffer) => void) | null = null;
  private resizeListener: (() => void) | null = null;
  private settingsFilePath: string | null = null;
  private hookErrorLogPath: string | null = null;
  private hookReceivedCount = 0;
  private hookHealthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resolvingHookApprovals = new Set<string>();
  private readonly pendingHookUserInputs = new Map<string, {
    socket: net.Socket;
    payload: ClaudeHookPayload;
    request: UserInputRequest;
    origin?: BridgeTurnOrigin;
  }>();
  private readonly resolvingHookUserInputs = new Set<string>();
  private readonly pendingHookApprovals = new Map<string, ClaudePendingHookApproval>();
  private recoveringInvalidResume = false;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private workingNoticeDelayMs = CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS;
  private lastCompactCompletionAtMs = 0;
  private startupOutputBuffer = "";
  private hasAutoConfirmedWorkspaceTrustPrompt = false;
  private pendingResume: ClaudePendingResume | null = null;
  private localResumeSessionEndObserved = false;
  private interactiveReady = true;
  private interactiveReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly interactiveReadyWaiters = new Set<ClaudeInteractiveReadyWaiter>();
  private remoteSubmitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteSubmitRetryIndex = 0;
  private remoteSubmitText: string | null = null;

  private readonly terminalControl: NativeTerminalControl = new NativeTerminalControl({
    write: (text) => this.writeToPty(text),
    identity: () => JSON.stringify([this.state.pid, this.runtimeSessionId, this.resumeConversationId]),
    isPromptEmpty: () => readClaudePermissionMode(this.terminalControl.text) !== null,
    assertReady: () => {
      if (!this.pty || this.state.status !== "idle" || this.pendingApproval || this.pendingResume) {
        throw new Error(t("adapter.claude.controlsIdle"));
      }
    },
  });
  private readonly nativeControls = new ClaudeNativeControls(this.terminalControl, () => this.resumeConversationId ?? this.runtimeSessionId ?? "");

  override async listModels(): Promise<BridgeModelOption[]> { return this.nativeControls.listModels(); }
  override async selectModel(modelId: string): Promise<BridgeModelOption> { return this.nativeControls.selectModel(modelId); }
  override async setPlanMode(enabled: boolean): Promise<boolean> { return this.nativeControls.setPlanMode(enabled); }

  constructor(options: AdapterOptions) {
    super(options);
    this.state.supportsApprovalRequestIds = true;
    this.state.supportsUserInputRequestIds = true;
    this.state.pendingUserInput = null;
    this.state.pendingApprovals = [];
    this.state.pendingApproval = null;
    const shouldRestoreInitialSession = options.sessionStartMode !== "new";
    this.runtimeSessionId = shouldRestoreInitialSession
      ? options.initialSharedSessionId ?? options.initialSharedThreadId ?? null
      : null;
    this.resumeConversationId = shouldRestoreInitialSession
      ? options.initialResumeConversationId ?? null
      : null;
    this.transcriptPath = shouldRestoreInitialSession
      ? options.initialTranscriptPath ?? null
      : null;
    if (this.runtimeSessionId) {
      this.state.sharedSessionId = this.runtimeSessionId;
      this.state.activeRuntimeSessionId = this.runtimeSessionId;
    }
    if (this.resumeConversationId) {
      this.state.resumeConversationId = this.resumeConversationId;
    }
    if (this.transcriptPath) {
      this.state.transcriptPath = this.transcriptPath;
    }
  }

  override async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    this.beginInteractiveReadinessWait();
    this.startupOutputBuffer = "";
    this.hasAutoConfirmedWorkspaceTrustPrompt = false;
    ensureClaudeWorkspaceTrustAccepted(this.options.cwd);

    // Validate transcript file exists before launching Claude CLI.
    // After a compact, the old transcript is deleted and the persisted
    // resumeConversationId becomes invalid, causing --resume to crash.
    if (this.transcriptPath) {
      try {
        fs.accessSync(this.transcriptPath);
      } catch {
        this.emitClaudeNotice(
          `Conversation transcript "${this.transcriptPath}" no longer exists (likely after compact). Starting fresh session.`,
          "warning",
        );
        this.transcriptPath = null;
        this.resumeConversationId = null;
        this.runtimeSessionId = null;
        this.state.transcriptPath = undefined;
        this.state.resumeConversationId = undefined;
        this.state.sharedSessionId = undefined;
        this.state.activeRuntimeSessionId = undefined;
      }
    }

    try {
      await this.startHookServer();
      await super.start();
      if (!this.interactiveReady) {
        this.setStatus("starting", "Waiting for Claude interactive session...");
      }
    } catch (error) {
      this.rejectInteractiveReadiness(
        error instanceof Error ? error : new Error(String(error)),
      );
      await this.stopHookServer();
      throw error;
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (this.terminalControl.active) throw new Error(t("adapter.claude.controlActive"));
    if (!this.pty) {
      throw new Error(t("adapter.claude.notRunning"));
    }
    if (this.state.status === "busy") {
      throw new Error(t("adapter.claude.busy"));
    }
    if (this.pendingApproval) {
      throw new Error(t("adapter.claude.approvalPending"));
    }
    if (this.state.status === "awaiting_input") throw new Error(t("adapter.claude.inputPending"));

    await this.waitForInteractiveReadiness();
    if (!this.pty) {
      throw new Error(t("adapter.claude.notRunning"));
    }
    if (this.getState().status === "busy") {
      throw new Error(t("adapter.claude.busy"));
    }
    if (this.pendingApproval) {
      throw new Error(t("adapter.claude.approvalPending"));
    }

    if (this.getState().status === "awaiting_input") throw new Error(t("adapter.claude.inputPending"));
    const normalizedText = normalizeOutput(text).trim();
    this.clearRemoteSubmitRetry();
    this.pendingInjectedInputs.push({
      normalizedText,
      createdAtMs: Date.now(),
    });
    this.pendingInjectedInputs = this.pendingInjectedInputs.slice(-8);
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.pendingCliApprovalHints = null;
    this.clearRemoteWorkingNotice(true);
    this.setStatus("busy");
    this.writeToPty(this.buildRemoteInputPayload(text));
    await delay(CLAUDE_REMOTE_ENTER_DELAY_MS);
    this.writeToPty("\r");
    this.armRemoteSubmitRetry(normalizedText);
    this.armRemoteWorkingNotice();
  }

  override async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    return listClaudeResumeSessions(this.options.cwd, limit);
  }

  override async resumeSession(sessionId: string): Promise<void> {
    if (this.terminalControl.active) throw new Error(t("adapter.claude.sessionControlActive"));
    if (!this.pty) {
      throw new Error(t("adapter.claude.notReady"));
    }
    if (this.pendingResume) {
      throw new Error(t("adapter.claude.switching"));
    }
    if (this.pendingApproval) {
      throw new Error(t("adapter.claude.approvalPending"));
    }
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      throw new Error(t("adapter.claude.switchBusy"));
    }
    if (this.state.status !== "idle") {
      throw new Error(`Claude cannot switch sessions while its status is ${this.state.status}.`);
    }

    const targetConversationId = sessionId.trim();
    if (!CLAUDE_SESSION_ID_RE.test(targetConversationId)) {
      throw new Error(`Invalid Claude session ID: ${targetConversationId}`);
    }
    if (!this.resolveClaudeResumeSessionFile(targetConversationId)) {
      throw new Error(
        `No Claude session ${targetConversationId} was found for ${this.options.cwd}.`,
      );
    }
    if (this.isClaudeSessionActiveElsewhere(targetConversationId)) {
      throw new Error(
        `Claude session ${targetConversationId} is active in another Claude process. Stop it before resuming from WeChat.`,
      );
    }

    this.setStatus("starting", `Switching Claude to session ${targetConversationId.slice(0, 12)}...`);
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingResume?.targetConversationId !== targetConversationId) {
          return;
        }
        const phase = this.pendingResume.sessionEndObserved
          ? " after the previous session ended"
          : "";
        this.pendingResume = null;
        this.setStatus("idle");
        reject(
          new Error(
            `Timed out waiting for Claude to resume session ${targetConversationId}${phase}.`,
          ),
        );
      }, CLAUDE_RESUME_TIMEOUT_MS);
      this.pendingResume = {
        targetConversationId,
        resolve,
        reject,
        timer,
        sessionEndObserved: false,
      };
    });

    this.writeToPty(`/resume ${targetConversationId}`);
    await delay(CLAUDE_REMOTE_ENTER_DELAY_MS);
    this.writeToPty("\r");
    await completion;
  }

  private isClaudeSessionActiveElsewhere(sessionId: string): boolean {
    if (sessionId === this.resumeConversationId) {
      return false;
    }
    try {
      const env = shared.buildCliEnvironment("claude");
      const target = shared.resolveSpawnTarget(this.options.command, "claude", { env });
      const result = spawnSync(
        target.file,
        [...target.args, "agents", "--json", "--cwd", this.options.cwd],
        {
          cwd: this.options.cwd,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        },
      );
      if (result.status !== 0 || !result.stdout.trim()) {
        return false;
      }
      const parsed = JSON.parse(result.stdout) as unknown;
      const sessions = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.sessions)
          ? parsed.sessions
          : [];
      return sessions.some((session) => {
        if (!isRecord(session)) {
          return false;
        }
        const candidateId =
          typeof session.id === "string"
            ? session.id
            : typeof session.sessionId === "string"
              ? session.sessionId
              : typeof session.session_id === "string"
                ? session.session_id
                : "";
        return candidateId === sessionId;
      });
    } catch {
      return false;
    }
  }

  private resolveClaudeResumeSessionFile(sessionId: string): string | null {
    return findClaudeResumeSessionFile(this.options.cwd, sessionId);
  }

  override async interrupt(): Promise<boolean> {
    this.terminalControl.cancel("The remote control operation was interrupted.");
    if (!this.pty) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearRemoteWorkingNotice(true);
    this.clearRemoteSubmitRetry();
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    if (this.pendingApproval) {
      // The flush above answered the pending hook approval with an empty
      // response, so the mirrored request is dead. Drop it — otherwise a
      // later /confirm targets a deleted requestId and every new message is
      // rejected by a stale "approval pending" state. Mirrors what the
      // socket-close path does via handleClosedClaudeHookApproval.
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
    }
    if (this.state.status === "awaiting_approval") {
      // Return to busy so the interrupt settle path (guarded on busy) can
      // complete the turn normally.
      this.setStatus("busy");
    }
    this.writeToPty("\u0003");
    this.scheduleTaskComplete(shared.INTERRUPT_SETTLE_DELAY_MS);
    return true;
  }

  override async reset(): Promise<void> {
    if (this.terminalControl.active) throw new Error(t("adapter.claude.sessionControlActive"));
    this.rejectPendingResume(new Error("Claude was reset during session switching."));
    this.clearRemoteWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.runtimeSessionId = null;
    this.resumeConversationId = null;
    this.transcriptPath = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.resumeConversationId = undefined;
    this.state.transcriptPath = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    await this.dispose();
    await this.start();
  }

  override async resolveApproval(
    action: ApprovalDecision,
    requestId?: string,
    options: ApprovalResolveOptions = {},
  ): Promise<boolean> {
    const id = requestId ?? this.pendingApproval?.requestId;
    if (id && this.pendingHookApprovals.has(id)) {
      const handled = await this.respondToClaudeHookApproval(id, action, options.reason);
      if (handled) {
        this.clearRemoteWorkingNotice();
        this.syncPendingHookApprovals();
      }
      return handled;
    }
    if (!this.pendingApproval || (requestId !== undefined && requestId !== this.pendingApproval.requestId)) return false;
    // Hook requests never fall through to keystrokes after their socket expires.
    if (this.pendingApproval.requestId || (action !== "confirm" && action !== "deny")) return false;
    const input = action === "confirm" ? this.pendingApproval.confirmInput : this.pendingApproval.denyInput;
    if (!input) {
      throw new Error(t("adapter.claude.approvalLocal"));
    }
    this.writeToPty(input);
    this.pendingCliApprovalHints = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("busy");
    return true;
  }

  override async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    if (!this.pendingHookApprovals.size) return await this.resolveApproval(action) ? 1 : 0;
    let count = 0;
    for (const id of Array.from(this.pendingHookApprovals.keys())) {
      if (await this.resolveApproval(action, id)) count++;
    }
    return count;
  }

  override async dispose(): Promise<void> {
    this.terminalControl.cancel("Claude is shutting down.");
    this.rejectPendingResume(new Error("Claude is shutting down during session switching."));
    this.detachLocalTerminal();
    this.clearRemoteWorkingNotice(true);
    this.clearRemoteSubmitRetry();
    this.rejectInteractiveReadiness(new Error("Claude is shutting down."));
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    await super.dispose();
    await this.stopHookServer();
  }

  protected buildSpawnArgs(): string[] {
    if (!this.settingsFilePath) {
      throw new Error("Claude companion settings are not ready.");
    }

    return buildClaudeCliArgs({
      settingsFilePath: this.settingsFilePath,
      resumeConversationId: this.resumeConversationId,
      profile: this.options.profile,
      includeNoAltScreen: shouldIncludeClaudeNoAltScreen(this.options.command),
      extraCliArgs: this.options.extraCliArgs,
    });
  }

  protected override afterStart(): void {
    this.attachLocalTerminal();
    this.resizePtyToTerminal();
    this.startHookHealthCheck();
  }

  protected override handleData(rawText: string): void {
    this.terminalControl.feed(rawText);
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    if (
      this.pendingResume &&
      (isClaudeInvalidResumeError(text) ||
        /Session .+ was not found|Found \d+ sessions matching|Failed to resume/i.test(text))
    ) {
      const failureLine = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /not found|matching|failed to resume/i.test(line));
      this.rejectPendingResume(
        new Error(failureLine || "Claude could not resume the requested session."),
      );
      return;
    }

    if (
      this.resumeConversationId &&
      !this.hasAcceptedInput &&
      !this.recoveringInvalidResume &&
      isClaudeInvalidResumeError(text)
    ) {
      void this.recoverFromInvalidResume(this.resumeConversationId);
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (this.maybeAutoConfirmWorkspaceTrustPrompt(text)) {
      return;
    }

    if (this.shouldTreatClaudeOutputAsCompactCompletion(text)) {
      this.completeClaudeCompact();
      return;
    }
    const compactFailure = this.extractClaudeCompactFailure(text);
    if (compactFailure) {
      this.failClaudeTurn(compactFailure);
      return;
    }

    const approval = detectCliApproval(text);
    if (approval) {
      this.clearRemoteWorkingNotice();
      if (this.pendingApproval) {
        this.pendingApproval = {
          ...this.pendingApproval,
          confirmInput: this.pendingApproval.confirmInput ?? approval.confirmInput,
          denyInput: this.pendingApproval.denyInput ?? approval.denyInput,
        };
        this.state.pendingApproval = this.pendingApproval;
      } else {
        this.pendingCliApprovalHints = {
          confirmInput: approval.confirmInput,
          denyInput: approval.denyInput,
        };
      }
      return;
    }

    if (!this.hasAcceptedInput) {
      return;
    }
  }

  private maybeAutoConfirmWorkspaceTrustPrompt(text: string): boolean {
    if (this.hasAcceptedInput || this.hasAutoConfirmedWorkspaceTrustPrompt) {
      return false;
    }

    this.startupOutputBuffer = `${this.startupOutputBuffer}${text}`.slice(
      -CLAUDE_STARTUP_OUTPUT_BUFFER_LIMIT,
    );
    if (!isClaudeWorkspaceTrustPrompt(this.startupOutputBuffer)) {
      return false;
    }

    this.hasAutoConfirmedWorkspaceTrustPrompt = true;
    this.writeToPty("\r");
    return true;
  }

  protected override handleExit(exitCode: number | undefined): void {
    this.terminalControl.cancel("Claude exited during the control operation.");
    this.detachLocalTerminal();
    this.clearRemoteWorkingNotice(true);
    this.clearRemoteSubmitRetry();
    this.pendingCliApprovalHints = null;
    this.rejectPendingResume(
      new Error("Claude exited before the requested session switch completed."),
    );
    if (!this.recoveringInvalidResume) {
      this.rejectInteractiveReadiness(
        new Error("Claude exited before its interactive session became ready."),
      );
    }
    void this.stopHookServer();
    if (this.recoveringInvalidResume && !this.shuttingDown) {
      this.clearCompletionTimer();
      this.pty = null;
      this.state.status = "stopped";
      this.state.pid = undefined;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      return;
    }
    super.handleExit(exitCode);
  }

  private async startHookServer(): Promise<void> {
    if (this.hookServer) {
      return;
    }

    this.hookToken = buildLocalCompanionToken();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buffer += chunk;
          // Cap the buffer: a single hook frame is tiny, so a frame larger
          // than 1 MiB means a misbehaving client (e.g. one that never sends a
          // newline). Without this the buffer could grow unbounded. Sibling
          // IPC paths already cap their buffers; this one did not.
          if (buffer.length > 1024 * 1024) {
            socket.destroy();
            return;
          }
          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0) {
              break;
            }

            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) {
              continue;
            }

            try {
              const envelope = JSON.parse(line) as {
                token?: string;
                requestId?: string;
                payload?: string;
              };
              if (
                envelope.token === this.hookToken &&
                typeof envelope.requestId === "string" &&
                typeof envelope.payload === "string"
              ) {
                this.handleClaudeHookEnvelope({
                  requestId: envelope.requestId,
                  rawPayload: envelope.payload,
                  socket,
                });
              }
            } catch {
              // Ignore malformed hook payloads.
            }
          }
        });
        const cleanupPendingRequestsForSocket = () => {
          for (const [requestId, pending] of this.pendingHookUserInputs.entries()) {
            if (pending.socket === socket) this.handleClosedClaudeHookUserInput(requestId);
          }
          for (const [requestId, pending] of this.pendingHookApprovals.entries()) {
            if (pending.socket === socket) {
              this.handleClosedClaudeHookApproval(requestId);
            }
          }
        };
        socket.once("close", cleanupPendingRequestsForSocket);
        socket.once("error", cleanupPendingRequestsForSocket);
      });

      this.hookServer = server;
      server.once("error", (error) => {
        reject(error);
      });
      server.listen(0, CLAUDE_HOOK_LISTEN_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a local Claude hook port."));
          return;
        }

        this.hookPort = address.port;
        try {
          this.writeClaudeRuntimeFiles();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async stopHookServer(): Promise<void> {
    this.flushPendingClaudeHookApprovals();
    if (!this.hookServer) {
      this.hookPort = null;
      this.settingsFilePath = null;
      return;
    }

    const server = this.hookServer;
    this.hookServer = null;
    this.hookPort = null;
    this.settingsFilePath = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private writeClaudeRuntimeFiles(): void {
    if (!this.hookPort || !this.hookToken) {
      throw new Error("Claude hook server is not ready.");
    }

    const { workspaceDir } = ensureWorkspaceChannelDir(this.options.cwd);
    // Scope the runtime directory to this adapter instance: two bridges in the
    // same cwd would otherwise overwrite each other's hook script, settings,
    // and error log, routing approvals and final replies to the wrong chat.
    // The hook token is unique per hook server (per instance), and the same
    // token regenerates the same directory across hook restarts.
    const runtimeDir = path.join(
      workspaceDir,
      `claude-runtime-${this.hookToken.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`,
    );
    fs.mkdirSync(runtimeDir, { recursive: true });

    const hookScriptPath = path.join(
      runtimeDir,
      process.platform === "win32" ? "hook.cmd" : "hook.sh",
    );
    const settingsFilePath = path.join(runtimeDir, "settings.json");
    const sourceHookEntryPath = path.join(MODULE_DIR, "claude-hook.ts");
    const hookEntryPath = fs.existsSync(sourceHookEntryPath)
      ? sourceHookEntryPath
      : path.join(MODULE_DIR, "claude-hook.js");

    const hookErrorLogPath = path.join(runtimeDir, "hook-error.log");
    this.hookErrorLogPath = hookErrorLogPath;

    fs.writeFileSync(
      hookScriptPath,
      buildClaudeHookScript({
        platform: process.platform,
        runtimeExecPath: process.execPath,
        hookEntryPath,
        hookPort: this.hookPort,
        hookToken: this.hookToken,
        hookErrorLogPath,
      }),
      "utf8",
    );
    if (process.platform !== "win32") {
      fs.chmodSync(hookScriptPath, 0o755);
    }

    const hookCommand =
      process.platform === "win32"
        ? quoteWindowsCommandArg(hookScriptPath)
        : quotePosixCommandArg(hookScriptPath);
    fs.writeFileSync(
      settingsFilePath,
      JSON.stringify(buildClaudeHookSettings(hookCommand), null, 2),
      "utf8",
    );
    this.settingsFilePath = settingsFilePath;
  }

  private attachLocalTerminal(): void {
    if (this.localTerminalInputListener || !this.pty) {
      return;
    }

    this.localTerminalInputListener = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.terminalControl.localInput(text);
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localTerminalInputListener);
    process.stdin.resume();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }

    this.resizeListener = () => {
      this.resizePtyToTerminal();
    };
    if (process.stdout.isTTY) {
      process.stdout.on("resize", this.resizeListener);
    }
  }

  private detachLocalTerminal(): void {
    if (this.localTerminalInputListener) {
      process.stdin.off("data", this.localTerminalInputListener);
      this.localTerminalInputListener = null;
    }
    if (this.resizeListener) {
      process.stdout.off("resize", this.resizeListener);
      this.resizeListener = null;
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  }

  private resizePtyToTerminal(): void {
    if (!this.pty) {
      return;
    }

    try {
      this.terminalControl.resize(process.stdout.columns || DEFAULT_COLS, process.stdout.rows || DEFAULT_ROWS);
      this.pty.resize?.(process.stdout.columns || DEFAULT_COLS, process.stdout.rows || DEFAULT_ROWS);
    } catch {
      // Best effort resize sync.
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Claude companion.
    }
  }

  private armRemoteWorkingNotice(): void {
    this.clearRemoteWorkingNotice();
    if (
      this.workingNoticeSent ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      this.pendingApproval ||
      this.state.activeTurnOrigin !== "wechat"
    ) {
      return;
    }

    this.workingNoticeTimer = setTimeout(() => {
      this.workingNoticeTimer = null;
      if (
        this.workingNoticeSent ||
        !this.hasAcceptedInput ||
        this.state.status !== "busy" ||
        this.pendingApproval ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      this.workingNoticeSent = true;
      this.emitClaudeNotice(`Claude is still working on:\n${this.currentPreview}`);
    }, this.workingNoticeDelayMs);
    this.workingNoticeTimer.unref?.();
  }

  private clearRemoteWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
    }
  }

  private startHookHealthCheck(): void {
    this.hookReceivedCount = 0;
    this.clearHookHealthCheck();
    this.hookHealthCheckTimer = setTimeout(() => {
      this.hookHealthCheckTimer = null;
      if (this.hookReceivedCount === 0 && !this.shuttingDown) {
        const logHint = this.hookErrorLogPath
          ? t("hook.healthCheck.logHint", { logPath: this.hookErrorLogPath })
          : "";
        this.emit({
          type: "stdout",
          text: [
            t("hook.healthCheck.warning"),
            logHint,
            t("hook.healthCheck.fixes", { package: getInstalledPackageName() }),
          ].filter(Boolean).join("\n"),
          timestamp: nowIso(),
        });
      }
    }, 15_000);
    this.hookHealthCheckTimer.unref?.();
  }

  private clearHookHealthCheck(): void {
    if (this.hookHealthCheckTimer) {
      clearTimeout(this.hookHealthCheckTimer);
      this.hookHealthCheckTimer = null;
    }
  }

  private emitClaudeNotice(text: string, level: BridgeNoticeLevel = "info"): void {
    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.emit({
      type: "notice",
      text: normalized,
      level,
      timestamp: nowIso(),
    });
  }

  private buildRemoteInputPayload(text: string): string {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalizedText.includes("\n")) {
      return normalizedText;
    }

    return `${CLAUDE_BRACKETED_PASTE_START}${normalizedText}${CLAUDE_BRACKETED_PASTE_END}`;
  }

  private beginInteractiveReadinessWait(): void {
    this.clearInteractiveReadinessTimer();
    this.interactiveReady = false;
    this.interactiveReadyTimer = setTimeout(() => {
      this.interactiveReadyTimer = null;
      this.markInteractiveReady();
    }, CLAUDE_INTERACTIVE_READY_TIMEOUT_MS);
    this.interactiveReadyTimer.unref?.();
  }

  private waitForInteractiveReadiness(): Promise<void> {
    if (this.interactiveReady) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.interactiveReadyWaiters.add({ resolve, reject });
    });
  }

  private markInteractiveReady(): void {
    if (this.interactiveReady) {
      return;
    }

    this.interactiveReady = true;
    this.clearInteractiveReadinessTimer();
    for (const waiter of this.interactiveReadyWaiters) {
      waiter.resolve();
    }
    this.interactiveReadyWaiters.clear();
    if (this.state.status === "starting" && !this.hasAcceptedInput) {
      this.setStatus("idle", "Claude interactive session is ready.");
    }
  }

  private rejectInteractiveReadiness(error: Error): void {
    this.clearInteractiveReadinessTimer();
    for (const waiter of this.interactiveReadyWaiters) {
      waiter.reject(error);
    }
    this.interactiveReadyWaiters.clear();
    this.interactiveReady = true;
  }

  private clearInteractiveReadinessTimer(): void {
    if (!this.interactiveReadyTimer) {
      return;
    }
    clearTimeout(this.interactiveReadyTimer);
    this.interactiveReadyTimer = null;
  }

  private armRemoteSubmitRetry(normalizedText: string): void {
    this.clearRemoteSubmitRetry();
    this.remoteSubmitText = normalizedText;
    this.remoteSubmitRetryIndex = 0;
    this.scheduleRemoteSubmitRetry();
  }

  private scheduleRemoteSubmitRetry(): void {
    const delayMs = CLAUDE_REMOTE_ENTER_RETRY_DELAYS_MS[this.remoteSubmitRetryIndex];
    if (delayMs === undefined || !this.remoteSubmitText) {
      return;
    }

    this.remoteSubmitRetryTimer = setTimeout(() => {
      this.remoteSubmitRetryTimer = null;
      if (
        !this.remoteSubmitText ||
        !this.pty ||
        this.state.status !== "busy" ||
        !this.pendingInjectedInputs.some(
          (input) => input.normalizedText === this.remoteSubmitText,
        )
      ) {
        this.clearRemoteSubmitRetry();
        return;
      }

      this.writeToPty("\r");
      this.remoteSubmitRetryIndex += 1;
      if (this.remoteSubmitRetryIndex >= CLAUDE_REMOTE_ENTER_RETRY_DELAYS_MS.length) {
        this.clearRemoteSubmitRetry();
        this.emitClaudeNotice(
          "Claude did not confirm the WeChat message submission. Press Enter in the local Claude terminal to retry.",
          "warning",
        );
        return;
      }
      this.scheduleRemoteSubmitRetry();
    }, delayMs);
    this.remoteSubmitRetryTimer.unref?.();
  }

  private clearRemoteSubmitRetry(): void {
    if (this.remoteSubmitRetryTimer) {
      clearTimeout(this.remoteSubmitRetryTimer);
      this.remoteSubmitRetryTimer = null;
    }
    this.remoteSubmitRetryIndex = 0;
    this.remoteSubmitText = null;
  }

  // Fallback heuristic for older Claude Code versions that lack PostCompact hooks.
  // The structured PostCompact hook event (handled in handleClaudeHookEnvelope) is
  // the reliable signal; this regex match serves as a best-effort fallback.
  private shouldTreatClaudeOutputAsCompactCompletion(text: string): boolean {
    if (
      this.state.status !== "busy" &&
      this.state.status !== "awaiting_approval" &&
      !this.hasAcceptedInput
    ) {
      return false;
    }

    return normalizeOutput(text)
      .split("\n")
      .some((line) => CLAUDE_COMPACT_OUTPUT_LINE_RE.test(line.trim()));
  }

  private isCompactCommandActive(): boolean {
    const preview = normalizeOutput(this.currentPreview).trim().toLowerCase();
    return preview === "/compact" || preview.startsWith("/compact ");
  }

  private extractClaudeCompactFailure(text: string): string | null {
    if (!this.isCompactCommandActive()) {
      return null;
    }

    const matchedLine = normalizeOutput(text)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => CLAUDE_COMPACT_FAILURE_RE.test(line));
    if (!matchedLine) {
      return null;
    }

    const detail = matchedLine
      .replace(/^Error:\s*Error during compaction:\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .replace(/^(?:compact|compaction)\s+failed:\s*/i, "")
      .trim();
    return truncatePreview(
      `Compact failed: ${detail || "Claude reported an unknown compaction error."}`,
      500,
    );
  }

  private failClaudeTurn(message: string): void {
    const hasActiveTurn =
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.hasAcceptedInput ||
      this.pendingApproval !== null ||
      this.state.activeTurnOrigin !== undefined ||
      this.currentPreview !== "(idle)";
    if (!hasActiveTurn) {
      return;
    }

    this.clearCompletionTimer();
    this.clearRemoteWorkingNotice(true);
    this.clearRemoteSubmitRetry();
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message,
      timestamp: nowIso(),
    });
    this.currentPreview = "(idle)";
  }

  private completeClaudeCompact(params?: {
    nextResumeConversationId?: string | null;
  }): void {
    const compactedAtMs = Date.now();
    const shouldEmitNotice =
      compactedAtMs - this.lastCompactCompletionAtMs > CLAUDE_COMPACT_DEDUP_MS;
    this.lastCompactCompletionAtMs = compactedAtMs;

    if (shouldEmitNotice) {
      const previousResumeConversationId = this.resumeConversationId;
      const nextResumeConversationId =
        params?.nextResumeConversationId ?? previousResumeConversationId;
      const detail =
        previousResumeConversationId &&
        nextResumeConversationId &&
        previousResumeConversationId !== nextResumeConversationId
          ? ` Old ID: ${previousResumeConversationId} → New ID: ${nextResumeConversationId}.`
          : "";
      this.emitClaudeNotice(
        `Conversation was compacted.${detail} Bridge is ready for new WeChat messages.`,
        "info",
      );
    }

    const shouldEmitTaskComplete =
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.hasAcceptedInput;
    const completedPreview = this.currentPreview;
    this.clearCompletionTimer();
    this.clearRemoteWorkingNotice(true);
    this.clearRemoteSubmitRetry();
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.setStatus("idle");
    if (shouldEmitTaskComplete) {
      this.emit({
        type: "task_complete",
        summary: completedPreview,
        timestamp: nowIso(),
      });
    }
    this.currentPreview = "(idle)";
  }

  private handleClaudeHookEnvelope(params: {
    requestId: string;
    rawPayload: string;
    socket: net.Socket;
  }): void {
    this.hookReceivedCount++;
    this.clearHookHealthCheck();
    const payload = parseClaudeHookPayload(params.rawPayload);
    if (!payload?.hook_event_name) {
      this.respondToClaudeHook(params.socket, params.requestId);
      return;
    }

    switch (payload.hook_event_name) {
      case "SessionStart":
        this.handleClaudeSessionStart(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "SessionEnd":
        this.handleClaudeSessionEnd(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "UserPromptSubmit":
        this.handleClaudeUserPromptSubmit(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PreToolUse":
        if (payload.tool_name === "AskUserQuestion") {
          this.handleClaudeUserInputRequest(params.requestId, payload, params.socket);
        } else {
          this.respondToClaudeHook(params.socket, params.requestId);
        }
        return;
      case "PostToolUse":
      case "PostToolUseFailure":
        this.releaseLocallyResolvedHookApprovals(payload);
        if (payload.tool_name === "AskUserQuestion" && payload.tool_use_id) {
          let removed = false;
          for (const [id, pending] of this.pendingHookUserInputs) {
            if (pending.payload.tool_use_id === payload.tool_use_id) {
              this.pendingHookUserInputs.delete(id);
              removed = true;
              this.respondToClaudeHook(pending.socket, id);
            }
          }
          if (removed) this.syncPendingHookUserInputs();
        }
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PermissionRequest":
        this.handleClaudePermissionRequest(params.requestId, payload, params.socket);
        return;
      case "Notification":
        if (payload.notification_type === "permission_prompt") {
          if (this.state.pendingUserInput) {
            this.setStatus("awaiting_input", "Claude is waiting for your answers.");
          } else if (this.pendingApproval) {
            this.setStatus("awaiting_approval", "Claude approval is required.");
          } else {
            this.emitClaudeNotice("Claude is waiting for a local permission prompt that has no remote approval hook. Resolve it in the local terminal.", "warning");
          }
        }
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "Stop":
        this.handleClaudeStop(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "StopFailure":
        this.handleClaudeStopFailure(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PostCompact":
        this.completeClaudeCompact();
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      default:
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
    }
  }

  private handleClaudeSessionStart(payload: {
    session_id?: string;
    source?: string;
    transcript_path?: string;
  }): void {
    this.markInteractiveReady();
    if (!payload.session_id) {
      return;
    }

    const previousRuntimeSessionId = this.runtimeSessionId;
    const previousResumeConversationId = this.resumeConversationId;
    const nextTranscriptPath =
      typeof payload.transcript_path === "string" && payload.transcript_path.trim()
        ? payload.transcript_path.trim()
        : null;
    const nextResumeConversationId = extractClaudeResumeConversationId(
      nextTranscriptPath ?? undefined,
    );
    const resumedConversationId = nextResumeConversationId ?? payload.session_id;
    const pendingResume = this.pendingResume;
    const pendingResumeMatches =
      payload.source === "resume" &&
      pendingResume !== null &&
      pendingResume.targetConversationId === resumedConversationId;
    const isInteractiveResume =
      payload.source === "resume" && Boolean(previousRuntimeSessionId);

    if (
      isInteractiveResume &&
      !pendingResumeMatches &&
      !this.localResumeSessionEndObserved
    ) {
      this.failClaudeTurn(
        "The active WeChat task was interrupted because the local Claude terminal switched sessions.",
      );
    }

    const compactedByTranscriptRotation =
      Boolean(this.transcriptPath) &&
      Boolean(nextTranscriptPath) &&
      this.transcriptPath !== nextTranscriptPath &&
      (this.state.status === "busy" ||
        this.state.status === "awaiting_approval" ||
        this.hasAcceptedInput);

    // Compact may keep the same runtime session id, so rely on the structured
    // source when available and fall back to transcript rotation while a turn is active.
    if (
      payload.source === "compact" ||
      compactedByTranscriptRotation
    ) {
      this.completeClaudeCompact({
        nextResumeConversationId,
      });
    }

    this.runtimeSessionId = payload.session_id;
    this.state.sharedSessionId = payload.session_id;
    this.state.activeRuntimeSessionId = payload.session_id;
    this.state.sharedThreadId = undefined;
    this.resumeConversationId = nextResumeConversationId;
    this.state.resumeConversationId = nextResumeConversationId ?? undefined;
    this.transcriptPath = nextTranscriptPath;
    this.state.transcriptPath = nextTranscriptPath ?? undefined;

    const timestamp = nowIso();
    const isStartupRestore =
      !previousRuntimeSessionId &&
      (payload.source === "resume" ||
        (nextResumeConversationId !== null &&
          nextResumeConversationId === previousResumeConversationId));
    const source: BridgeThreadSwitchSource = pendingResumeMatches
      ? "wechat"
      : isStartupRestore
        ? "restore"
        : "local";
    const reason: BridgeThreadSwitchReason = pendingResumeMatches
      ? "wechat_resume"
      : isStartupRestore
        ? "startup_restore"
        : "local_follow";

    this.localResumeSessionEndObserved = false;

    if (
      pendingResume &&
      payload.source === "resume" &&
      !pendingResumeMatches
    ) {
      this.rejectPendingResume(
        new Error(
          `Claude resumed unexpected session ${resumedConversationId}; expected ${pendingResume.targetConversationId}.`,
        ),
      );
    }

    if (previousRuntimeSessionId === payload.session_id) {
      if (pendingResumeMatches) {
        this.resolvePendingResume();
      }
      return;
    }

    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    this.emit({
      type: "session_switched",
      sessionId: payload.session_id,
      source,
      reason,
      timestamp,
    });
    if (pendingResumeMatches) {
      this.resolvePendingResume();
    }
  }

  private handleClaudeSessionEnd(payload: { reason?: string }): void {
    this.flushPendingClaudeHookApprovals();
    if (payload.reason !== "resume") {
      return;
    }
    if (this.pendingResume) {
      this.pendingResume.sessionEndObserved = true;
      return;
    }
    this.localResumeSessionEndObserved = true;
    this.failClaudeTurn(
      "The active WeChat task was interrupted because the local Claude terminal switched sessions.",
    );
  }

  private resolvePendingResume(): void {
    const pending = this.pendingResume;
    if (!pending) {
      return;
    }
    this.pendingResume = null;
    clearTimeout(pending.timer);
    this.setStatus("idle");
    pending.resolve();
  }

  private rejectPendingResume(error: Error): void {
    const pending = this.pendingResume;
    if (!pending) {
      return;
    }
    this.pendingResume = null;
    clearTimeout(pending.timer);
    this.setStatus("idle");
    pending.reject(error);
  }

  private handleClaudeUserPromptSubmit(payload: { prompt?: string }): void {
    // A prompt cannot be submitted while a permission dialog is open: any
    // approval still pending here was rejected locally, which ends the turn
    // without a hook.
    this.releaseStaleHookApprovals(Array.from(this.pendingHookApprovals.values()));
    const prompt =
      typeof payload.prompt === "string" ? normalizeOutput(payload.prompt).trim() : "";
    if (!prompt) {
      return;
    }

    const injectedIndex = findInjectedClaudePromptIndex(prompt, this.pendingInjectedInputs);
    if (injectedIndex >= 0) {
      this.clearRemoteSubmitRetry();
      this.pendingInjectedInputs.splice(injectedIndex, 1);
      return;
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(prompt);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "local";
    this.pendingCliApprovalHints = null;
    this.clearRemoteWorkingNotice(true);
    this.setStatus("busy");
    this.emit({
      type: "mirrored_user_input",
      text: prompt,
      origin: "local",
      timestamp: nowIso(),
    });
  }

  private async recoverFromInvalidResume(failedResumeConversationId: string): Promise<void> {
    if (this.recoveringInvalidResume) {
      return;
    }

    this.recoveringInvalidResume = true;
    this.clearRemoteWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.runtimeSessionId = null;
    this.resumeConversationId = null;
    this.transcriptPath = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.resumeConversationId = undefined;
    this.state.transcriptPath = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    this.emitClaudeNotice(
      `Saved Claude conversation ${failedResumeConversationId} is no longer available. Starting a fresh Claude session.`,
      "warning",
    );

    try {
      await this.reset();
    } catch (error) {
      // recoverFromInvalidResume is invoked fire-and-forget (void) and there is
      // no global unhandled-rejection handler, so a throwing reset() must be
      // caught here to avoid crashing the bridge.
      this.emit({
        type: "fatal_error",
        message: `Failed to restart Claude after invalid resume: ${String(error)}`,
        timestamp: nowIso(),
      });
    } finally {
      this.recoveringInvalidResume = false;
    }
  }

  private handleClaudePermissionRequest(
    requestId: string,
    payload: ClaudeHookPayload,
    socket: net.Socket,
  ): void {
    this.clearRemoteWorkingNotice();
    if (payload.tool_name === "AskUserQuestion") {
      this.handleClaudeUserInputRequest(requestId, { ...payload, hook_event_name: "PermissionRequest" }, socket);
      return;
    }
    const denyMessage = getClaudeOutboundAttachmentDenyMessage(payload);
    if (denyMessage) {
      this.respondToClaudeHook(
        socket,
        requestId,
        buildClaudePermissionDecisionHookOutput("deny", denyMessage),
      );
      return;
    }

    const autoResponse = getClaudePermissionAutoResponse(payload, { workspace: this.options.cwd });
    if (autoResponse) {
      if (!this.pendingApproval && !this.state.pendingApproval && !this.state.pendingUserInput) {
        this.setStatus(
          "busy",
          `Claude approval auto-approved: ${truncatePreview(autoResponse.reason, 180)}`,
        );
      }
      this.respondToClaudeHook(
        socket,
        requestId,
        buildClaudePermissionDecisionHookOutput(autoResponse.action),
      );
      this.emit({ type: "approval_auto_resolved", kind: autoResponse.kind, timestamp: nowIso() });
      return;
    }

    if (this.pendingHookApprovals.has(requestId)) return;
    const request = {
      ...buildClaudePermissionApprovalRequest(payload),
      requestId,
      confirmInput: this.pendingCliApprovalHints?.confirmInput,
      denyInput: this.pendingCliApprovalHints?.denyInput,
    };
    this.pendingHookApprovals.set(requestId, {
      requestId,
      socket,
      request,
      toolCallKey: getClaudeToolCallKey(payload),
      permissionSuggestions: payload.permission_suggestions,
      origin: this.state.activeTurnOrigin,
    });
    this.pendingCliApprovalHints = null;
    this.syncPendingHookApprovals();
  }

  private syncPendingHookApprovals(): void {
    const previousId = this.pendingApproval?.requestId;
    const entries = Array.from(this.pendingHookApprovals.values());
    const requests = entries.map((pending) => pending.request);
    this.pendingApproval = requests[0] ?? null;
    this.state.pendingApproval = this.pendingApproval;
    this.state.pendingApprovals = requests;
    this.state.pendingApprovalOrigin = entries[0]?.origin;
    this.setStatus(requests.length ? "awaiting_approval" : this.state.pendingUserInput ? "awaiting_input" : "busy");
    this.emit({ type: "approval_state_changed", requests, timestamp: nowIso() });
    if (requests[0] && requests[0].requestId !== previousId) {
      this.emit({ type: "approval_required", request: requests[0], timestamp: nowIso() });
    }
  }

  /**
   * Claude races its local permission dialog against the hook. A tool that
   * ran (or failed) was approved, so its hook approval is stale.
   */
  private releaseLocallyResolvedHookApprovals(payload: ClaudeHookPayload): void {
    const toolCallKey = getClaudeToolCallKey(payload);
    const stale = Array.from(this.pendingHookApprovals.values())
      .filter((pending) => pending.toolCallKey === toolCallKey);
    this.releaseStaleHookApprovals(stale);
  }

  /** Release hook approvals that Claude has already resolved without them. */
  private releaseStaleHookApprovals(stale: ClaudePendingHookApproval[]): void {
    if (!stale.length) return;
    for (const pending of stale) this.cancelPendingClaudeHookApproval(pending.requestId);
    this.syncPendingHookApprovals();
  }

  private handleClosedClaudeHookApproval(requestId: string): void {
    if (!this.pendingHookApprovals.delete(requestId)) return;
    this.syncPendingHookApprovals();
    if (!this.pendingHookApprovals.size) {
      this.setStatus("awaiting_approval", "Claude approval must be resolved in the local terminal.");
    }
    this.emitClaudeNotice(
      "Claude approval can no longer be resolved from WeChat. Approve it in the local Claude terminal.",
      "warning",
    );
  }

  private readClaudeTranscriptFinalReply(): string | null {
    if (!this.transcriptPath) {
      return null;
    }

    try {
      const rawTranscript = fs.readFileSync(this.transcriptPath, "utf8");
      return extractClaudeTranscriptFinalReply(rawTranscript);
    } catch {
      return null;
    }
  }

  private resolveClaudeFinalReplyText(payload: { last_assistant_message?: string }): string {
    return (
      extractClaudeAssistantMessageText(payload) ||
      this.readClaudeTranscriptFinalReply() ||
      normalizeClaudeAssistantMessage(payload)
    );
  }

  private handleClaudeStop(payload: {
    session_id?: string;
    last_assistant_message?: string;
  }): void {
    if (
      payload.session_id &&
      this.runtimeSessionId &&
      payload.session_id !== this.runtimeSessionId
    ) {
      return;
    }
    if (
      !this.hasAcceptedInput &&
      this.state.activeTurnOrigin === undefined &&
      this.currentPreview === "(idle)"
    ) {
      return;
    }
    this.clearRemoteSubmitRetry();
    this.clearRemoteWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.setStatus("idle");
    this.emit({
      type: "final_reply",
      text: this.resolveClaudeFinalReplyText(payload),
      timestamp: nowIso(),
    });
    this.emit({
      type: "task_complete",
      summary: this.currentPreview,
      timestamp: nowIso(),
    });
    this.currentPreview = "(idle)";
  }

  private handleClaudeStopFailure(payload: {
    session_id?: string;
    error?: string;
    error_details?: string;
    last_assistant_message?: string;
  }): void {
    if (
      payload.session_id &&
      this.runtimeSessionId &&
      payload.session_id !== this.runtimeSessionId
    ) {
      return;
    }
    this.failClaudeTurn(buildClaudeFailureMessage(payload));
  }

  private respondToClaudeHook(
    socket: net.Socket,
    requestId: string,
    stdout?: string,
  ): void {
    try {
      socket.end(`${JSON.stringify({ requestId, stdout })}\n`);
    } catch {
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private async respondToClaudeHookApproval(
    requestId: string,
    action: ApprovalDecision,
    reason?: string,
  ): Promise<boolean> {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return false;
    }

    if (pending.socket.destroyed || pending.socket.writableEnded || this.resolvingHookApprovals.has(requestId)) return false;
    this.resolvingHookApprovals.add(requestId);
    try {
      if (action === "always" && !pending.request.extraDecisions?.includes("always")) return false;
      await this.writeClaudeHookResponse(
        pending.socket,
        requestId,
        buildClaudePermissionDecisionHookOutput(action, reason || undefined, pending.permissionSuggestions),
      );
      this.pendingHookApprovals.delete(requestId);
      return true;
    } catch {
      return false;
    } finally {
      this.resolvingHookApprovals.delete(requestId);
    }
  }

  private async writeClaudeHookResponse(socket: net.Socket, requestId: string, stdout: string): Promise<void> {
    const response = `${JSON.stringify({ requestId, stdout })}\n`;
    const candidate: unknown = socket;
    if (!(candidate instanceof net.Socket)) {
      socket.end(response);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("error", onError); socket.off("close", onClose); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Claude hook closed before its reply was written.")); };
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.end(response, () => { cleanup(); resolve(); });
    });
  }

  private handleClaudeUserInputRequest(requestId: string, payload: ClaudeHookPayload, socket: net.Socket): void {
    const request = buildClaudeUserInputRequest(payload, requestId);
    const existingAnswers = payload.tool_input?.answers;
    if (!request || (existingAnswers && typeof existingAnswers === "object"
      && request.questions.every((question) => {
        const answer = (existingAnswers as Record<string, unknown>)[question.question];
        return typeof answer === "string" && answer.trim();
      }))) {
      this.respondToClaudeHook(socket, requestId);
      return;
    }
    if (this.pendingHookUserInputs.has(requestId)) return;
    this.clearRemoteWorkingNotice();
    this.pendingHookUserInputs.set(requestId, { socket, payload, request, origin: this.state.activeTurnOrigin });
    this.syncPendingHookUserInputs();
  }

  private syncPendingHookUserInputs(): void {
    const previousId = this.state.pendingUserInput?.requestId;
    const head = this.pendingHookUserInputs.values().next().value;
    this.state.pendingUserInput = head?.request ?? null;
    this.state.pendingUserInputOrigin = head?.origin;
    this.setStatus(head ? "awaiting_input" : this.pendingApproval ? "awaiting_approval" : "busy");
    if (head && head.request.requestId !== previousId) {
      this.emit({ type: "user_input_required", request: head.request, timestamp: nowIso() });
    }
  }

  private handleClosedClaudeHookUserInput(requestId: string): void {
    if (!this.pendingHookUserInputs.delete(requestId)) return;
    this.syncPendingHookUserInputs();
    if (!this.pendingHookUserInputs.size && !this.pendingApproval) this.setStatus("awaiting_input");
    this.emitClaudeNotice("Claude question hook expired or disconnected. Answer in the local Claude terminal, or use /stop.", "warning");
  }

  override async submitUserInput(answers: Record<string, string[]>, requestId?: string): Promise<boolean> {
    const id = requestId ?? this.state.pendingUserInput?.requestId;
    if (!id || id !== this.state.pendingUserInput?.requestId || this.resolvingHookUserInputs.has(id)) return false;
    const pending = this.pendingHookUserInputs.get(id);
    if (!pending || pending.socket.destroyed || pending.socket.writableEnded) return false;
    const stdout = buildClaudeUserInputHookOutput(pending.payload, pending.request, answers);
    if (!stdout) return false;
    this.resolvingHookUserInputs.add(id);
    try {
      await this.writeClaudeHookResponse(pending.socket, id, stdout);
      if (this.pendingHookUserInputs.get(id) !== pending) return false;
      this.pendingHookUserInputs.delete(id);
      this.syncPendingHookUserInputs();
      return true;
    } catch {
      return false;
    } finally {
      this.resolvingHookUserInputs.delete(id);
    }
  }

  private cancelPendingClaudeHookApproval(requestId: string): void {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return;
    }

    this.respondToClaudeHook(pending.socket, requestId);
    this.pendingHookApprovals.delete(requestId);
  }

  private flushPendingClaudeHookApprovals(): void {
    const userInputs = Array.from(this.pendingHookUserInputs.entries());
    this.pendingHookUserInputs.clear();
    this.state.pendingUserInput = null;
    this.state.pendingUserInputOrigin = undefined;
    for (const [id, pending] of userInputs) this.respondToClaudeHook(pending.socket, id);
    const hadPending = this.pendingHookApprovals.size > 0;
    if (userInputs.length && !hadPending) this.setStatus(this.state.status);
    for (const requestId of Array.from(this.pendingHookApprovals.keys())) {
      this.cancelPendingClaudeHookApproval(requestId);
    }
    this.state.pendingApprovals = [];
    if (hadPending) {
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      this.emit({ type: "approval_state_changed", requests: [], timestamp: nowIso() });
    }
  }
}
