import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CodexModelOption,
  BridgeResumeSessionCandidate,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
} from "./bridge-types.ts";
import {
  detectCliApproval,
} from "./bridge-utils.ts";
import {
  normalizeOutput,
  nowIso,
  summarizeOutput,
  truncatePreview,
} from "../core/text-utils.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import * as shared from "./bridge-adapters.shared.ts";
import {
  requestCodexVisibleClientShutdown,
  requestCodexVisibleThreadSwitch,
} from "../companion/codex-visible-client-link.ts";
import { readLocalCompanionEndpoint } from "../companion/local-companion-link.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  CODEX_REMOTE_AUTH_TOKEN_ENV,
  LOCAL_CLIENT_PROTOCOL_VERSION,
  type LocalClientEndpoint,
} from "../runtime/runtime-types.ts";

type AdapterOptions = shared.AdapterOptions;
type CodexActiveTurn = shared.CodexActiveTurn;
type CodexPendingApprovalRequest = shared.CodexPendingApprovalRequest;
type CodexPendingUserInputRequest = shared.CodexPendingUserInputRequest;
type CodexQueuedNotification = shared.CodexQueuedNotification;
type CodexRpcPendingRequest = shared.CodexRpcPendingRequest;
type CodexRpcRequestId = shared.CodexRpcRequestId;
type SpawnTarget = shared.SpawnTarget;
type CodexThreadAnnouncementSignal =
  | "status_changed"
  | "thread_started"
  | "session_fallback"
  | "turn_started"
  | "user_message";
type CodexPendingThreadAnnouncement = {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
  signals: Set<CodexThreadAnnouncementSignal>;
  timer: ReturnType<typeof setTimeout> | null;
};
type CodexPendingVisibleResume = {
  targetThreadId: string;
};

export function parseCodexCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function isCodexVersionInCompatibilityRange(version: string): boolean {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const major = parts[0] ?? -1;
  const minor = parts[1] ?? -1;
  return major === 0 && minor >= 149 && minor <= 151;
}

const {
  CODEX_APP_SERVER_HOST,
  CODEX_APP_SERVER_READY_TIMEOUT_MS,
  CODEX_FINAL_REPLY_SETTLE_DELAY_MS,
  CODEX_RECENT_SESSION_KEY_LIMIT,
  CODEX_RPC_CONNECT_RETRY_MS,
  CODEX_RPC_RECONNECT_TIMEOUT_MS,
  CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS,
  CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS,
  CODEX_SESSION_POLL_INTERVAL_MS,
  CODEX_STARTUP_WARMUP_MS,
  CODEX_THREAD_SIGNAL_TTL_MS,
  INTERRUPT_SETTLE_DELAY_MS,
  appendBoundedLog,
  buildCodexApprovalRequest,
  buildCodexCliArgs,
  buildCodexDynamicToolCallFailureResponse,
  buildCodexMcpServerElicitationDeclineResponse,
  buildCodexPermissionsRequestApprovalResponse,
  buildCodexUserInputRequest,
  coerceWebSocketMessageData,
  delay,
  describeUnknownError,
  extractCodexFinalTextFromItem,
  extractCodexThreadFollowIdFromStatusChanged,
  extractCodexThreadStartedThreadId,
  extractCodexUserMessageText,
  findCodexSessionFile,
  findRecentCodexSessionFileForCwd,
  getCodexRpcRequestId,
  getCodexApprovalAutoResponse,
  getCodexWechatOutboundAttachmentDenyMessage,
  getNotificationThreadId,
  getNotificationTurnId,
  isRecord,
  isRecentIsoTimestamp,
  listCodexResumeSessions,
  normalizeComparablePath,
  normalizeCodexRpcError,
  reserveLocalPort,
  resolveSpawnTarget,
  shouldAutoCompleteCodexWechatTurnAfterFinalReply,
  shouldIgnoreCodexSessionReplayEntry,
  shouldRecoverCodexStaleBusyState,
  waitForTcpPort,
} = shared;

const CODEX_LOCAL_THREAD_ANNOUNCE_SETTLE_MS = 150;
const CODEX_NON_BLOCKING_USER_INPUT_TIMEOUT_MS = 120_000;
const CODEX_RESUME_REPLAY_SETTLE_MS = 5_000;

function getCodexThreadStatusType(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}

function getCodexThreadTitle(thread: Record<string, unknown>): string {
  const name = typeof thread.name === "string" ? normalizeOutput(thread.name).trim() : "";
  const preview =
    typeof thread.preview === "string" ? normalizeOutput(thread.preview).trim() : "";
  const threadId = typeof thread.id === "string" ? thread.id : "";
  return truncatePreview(name || preview || `Codex thread ${threadId.slice(0, 8)}`, 120);
}

export function buildCodexResumeCandidatesFromThreadList(
  response: unknown,
  cwd: string,
  limit: number,
): BridgeResumeSessionCandidate[] {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new Error("Codex returned an invalid thread/list response.");
  }
  const currentCwd = normalizeComparablePath(cwd);
  return response.data
    .filter((thread): thread is Record<string, unknown> => isRecord(thread))
    .filter((thread) => typeof thread.id === "string")
    .filter((thread) => {
      const threadCwd = typeof thread.cwd === "string" ? thread.cwd : "";
      return threadCwd && normalizeComparablePath(threadCwd) === currentCwd;
    })
    .filter((thread) => typeof thread.parentThreadId !== "string")
    .map((thread) => {
      const updatedAt =
        typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt)
          ? thread.updatedAt * 1_000
          : 0;
      const threadId = thread.id as string;
      return {
        sessionId: threadId,
        threadId,
        title: getCodexThreadTitle(thread),
        lastUpdatedAt: new Date(updatedAt).toISOString(),
        source: "codex",
      } satisfies BridgeResumeSessionCandidate;
    })
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit));
}

export class CodexPtyAdapter extends AbstractPtyAdapter {
  readonly runtimeKind = "codex_runtime_host" as const;

  private appServer: ChildProcessWithoutNullStreams | null = null;
  private nativeProcess: ChildProcess | null = null;
  private appServerPort: number | null = null;
  private appServerShuttingDown = false;
  private appServerLog = "";
  private appServerAuthToken: string | null = null;
  private appServerAuthTokenFilePath: string | null = null;
  private rpcSocket: WebSocket | null = null;
  private lastRpcCloseDetail = "";
  private rpcShuttingDown = false;
  private rpcReconnectPromise: Promise<boolean> | null = null;
  private cleanPanelExitInProgress = false;
  private rpcRequestCounter = 0;
  private pendingRpcRequests = new Map<string, CodexRpcPendingRequest>();
  private subscribedThreadIds = new Set<string>();
  private pendingThreadSubscriptions = new Map<string, Promise<boolean>>();
  private sharedThreadId: string | null = null;
  private previousCollaborationMode: Record<string, unknown> | null = null;
  private announcedThreadId: string | null = null;
  private localThreadFollowBlockedUntilMs = 0;
  private pendingThreadStatusChecks = new Map<string, Promise<void>>();
  private threadStatusCheckEpoch = 0;
  private pendingThreadAnnouncement: CodexPendingThreadAnnouncement | null = null;
  private activeTurn: CodexActiveTurn | null = null;
  private bridgeOwnedTurnIds = new Set<string>();
  private recentBridgeThreadSignalAtById = new Map<string, number>();
  private pendingTurnStart = false;
  private pendingTurnThreadId: string | null = null;
  private interruptPendingTurnStart = false;
  private pendingThreadFollowId: string | null = null;
  private pendingVisibleResume: CodexPendingVisibleResume | null = null;
  private bridgeResumeReplayThreadId: string | null = null;
  private bridgeResumeReplayUntilMs = 0;
  private pendingApprovalRequests: CodexPendingApprovalRequest[] = [];
  private pendingUserInputRequest: CodexPendingUserInputRequest | null = null;
  private pendingUserInputTimer: ReturnType<typeof setTimeout> | null = null;
  private userInputAutoResolutionDelayMs = CODEX_NON_BLOCKING_USER_INPUT_TIMEOUT_MS;
  private queuedTurnNotifications: CodexQueuedNotification[] = [];
  private queuedTurnServerRequests: Array<{
    requestId: CodexRpcRequestId;
    method: CodexPendingApprovalRequest["method"] | CodexPendingUserInputRequest["method"];
    params: Record<string, unknown>;
  }> = [];
  private mirroredUserInputTurnIds = new Set<string>();
  private turnFinalMessages = new Map<string, Map<string, string>>();
  private turnDeltaByItem = new Map<string, Map<string, string>>();
  private turnErrorById = new Map<string, string>();
  private turnLastActivityAtMs = new Map<string, number>();
  private startupBlocker: string | null = null;
  private warmupUntilMs = 0;
  private sessionFilePath: string | null = null;
  private sessionPollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionReadOffset = 0;
  private sessionPartialLine = "";
  private sessionFinalText: string | null = null;
  private sessionIgnoreBeforeMs: number | null = null;
  private nextSessionFallbackScanAtMs = 0;
  private completedTurnIds = new Set<string>();
  private completedTurnOrder: string[] = [];
  private pendingInjectedInputs: Array<{
    text: string;
    normalizedText: string;
    createdAtMs: number;
  }> = [];
  private localInputListener: ((chunk: string | Buffer) => void) | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private finalReplyCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  private finalReplyCompletionTurnId: string | null = null;
  private resumeThreadId: string | null;
  private codexCliVersion: string | null = null;
  private readonly localClientInstanceId = `${process.pid}-${Date.now().toString(36)}`;

  constructor(options: AdapterOptions) {
    super(options);
    this.resumeThreadId = options.sessionStartMode === "new"
      ? null
      : options.initialSharedSessionId ?? options.initialSharedThreadId ?? null;
    if (this.resumeThreadId && options.renderMode !== "panel") {
      this.state.sharedSessionId = this.resumeThreadId;
      this.state.sharedThreadId = this.resumeThreadId;
    }
  }

  override async start(): Promise<void> {
    if (this.isCodexClientRunning()) {
      return;
    }

    if (this.isHeadlessRuntimeMode()) {
      this.setStatus("starting", `Starting ${this.options.kind} runtime host...`);
    }

    this.codexCliVersion = this.detectCodexCliVersion();
    const compatibility = this.codexCliVersion
      ? isCodexVersionInCompatibilityRange(this.codexCliVersion)
        ? `compatible=${this.codexCliVersion}`
        : `outside-supported-range=${this.codexCliVersion}`
      : "unknown-version";
    this.setStatus("starting", `Codex protocol compatibility: ${compatibility}.`);

    await this.startAppServer();
    await this.connectRpcClient();
    await this.restoreInitialSharedThreadIfNeeded();

    try {
      if (this.isNativePanelMode()) {
        await this.startNativeClient();
      } else if (this.isHeadlessRuntimeMode()) {
        this.shuttingDown = false;
        this.cleanPanelExitInProgress = false;
        this.hasAcceptedInput = true;
        this.state.pid = this.appServer?.pid ?? undefined;
        this.state.startedAt = nowIso();
        this.state.pendingApproval = null;
        this.afterStart();
        this.setStatus("idle", `${this.options.kind} adapter is ready.`);
      } else {
        await super.start();
      }
    } catch (err) {
      await this.disconnectRpcClient();
      await this.stopAppServer();
      throw err;
    }
  }

  async prepareVisibleClientSession(): Promise<boolean> {
    if (this.isNativePanelMode() || this.sharedThreadId) {
      return Boolean(this.sharedThreadId);
    }

    const threadId = await this.ensureThreadStarted();
    return Boolean(threadId);
  }

  protected buildSpawnArgs(): string[] {
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }

    return buildCodexCliArgs(`ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`, {
      inlineMode: this.options.renderMode !== "panel",
      profile: this.options.profile,
      extraCliArgs: this.options.extraCliArgs,
    });
  }

  protected override afterStart(): void {
    this.warmupUntilMs = this.usesRpcTurnTransport()
      ? 0
      : Date.now() + CODEX_STARTUP_WARMUP_MS;
    if (this.isEmbeddedCliMode()) {
      this.attachLocalInputForwarding();
    }
    this.startSessionPolling();
  }

  override async sendInput(text: string): Promise<void> {
    if (this.usesRpcTurnTransport()) {
      await this.sendPanelTurn(text);
      return;
    }

    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm or /deny.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    await delay(this.warmupUntilMs - Date.now());
    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.rememberInjectedInput(text);
    this.setStatus("busy");
    this.state.activeTurnOrigin = "wechat";
    await this.typeIntoPty(text.replace(/\r?\n/g, "\r"));
    await delay(40);
    this.writeToPty("\r");
  }

  override async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    if (this.usesRpcTurnTransport()) {
      return await this.listAppServerResumeSessions(limit);
    }
    return listCodexResumeSessions(this.options.cwd, limit);
  }

  override async resumeSession(threadId: string): Promise<void> {
    if (!this.isHeadlessRuntimeMode()) {
      throw new Error(
        'WeChat /resume requires the managed "wechat-codex" visible client.',
      );
    }
    await this.resumeVisibleSharedThread(threadId);
  }

  override async listModels(): Promise<CodexModelOption[]> {
    if (!this.usesRpcTurnTransport() || !this.sharedThreadId) {
      throw new Error("Codex model selection requires an active app-server thread.");
    }
    const response = await this.sendRpcRequest("model/list", { includeHidden: false });
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const current = await this.readCodexThreadSettings();
    const models = data.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : "";
      if (!id) return [];
      const displayName = typeof item.displayName === "string" ? item.displayName : id;
      const efforts = Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts.filter((value): value is string => typeof value === "string")
        : undefined;
      return [{ id, displayName, isCurrent: id === current.model, supportedReasoningEfforts: efforts }];
    });
    return models;
  }

  override async selectModel(modelId: string): Promise<CodexModelOption> {
    const models = await this.listModels();
    const selected = models.find((model) => model.id === modelId);
    if (!selected) throw new Error(`Codex model ${modelId} is not available.`);
    await this.sendRpcRequest("thread/settings/update", { threadId: this.sharedThreadId, model: selected.id });
    return selected;
  }

  override async setPlanMode(enabled: boolean): Promise<boolean> {
    if (!this.usesRpcTurnTransport() || !this.sharedThreadId) {
      throw new Error("Codex plan mode requires an active app-server thread.");
    }
    const settings = await this.readCodexThreadSettings();
    if (enabled) {
      const response = await this.sendRpcRequest("collaborationMode/list", {});
      const modes = isRecord(response) && Array.isArray(response.data) ? response.data : [];
      const plan = modes.find((item) => isRecord(item) && (item.mode === "plan" || item.name?.toString().toLowerCase() === "plan"));
      if (!isRecord(plan)) throw new Error("Codex plan mode is not available in this app-server.");
      this.previousCollaborationMode = isRecord(settings.collaborationMode) ? settings.collaborationMode : null;
      const mode = typeof plan.mode === "string" ? plan.mode : "plan";
      const model = typeof plan.model === "string" ? plan.model : settings.model;
      const effort = plan.reasoning_effort ?? plan.reasoningEffort ?? null;
      await this.sendRpcRequest("thread/settings/update", {
        threadId: this.sharedThreadId,
        collaborationMode: { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } },
      });
      return true;
    }
    const previous = this.previousCollaborationMode ?? {
      mode: "default",
      settings: { model: settings.model, reasoning_effort: settings.effort ?? null, developer_instructions: null },
    };
    await this.sendRpcRequest("thread/settings/update", {
      threadId: this.sharedThreadId,
      collaborationMode: previous,
    });
    this.previousCollaborationMode = null;
    return false;
  }

  private async readCodexThreadSettings(): Promise<{ model: string; effort?: unknown; collaborationMode?: unknown }> {
    const response = await this.sendRpcRequest("thread/read", { threadId: this.sharedThreadId, includeTurns: false });
    const thread = isRecord(response) && isRecord(response.thread) ? response.thread : null;
    if (!thread || typeof thread.model !== "string") throw new Error("Codex did not return the current thread model.");
    return { model: thread.model, effort: thread.reasoningEffort, collaborationMode: thread.collaborationMode };
  }

  override async interrupt(): Promise<boolean> {
    if (this.usesRpcTurnTransport()) {
      return await this.interruptPanelTurn();
    }

    if (!this.pty) {
      return false;
    }

    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearPendingApprovalState();
    this.writeToPty("\u0003");
    this.armInterruptFallback();
    return true;
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval && this.pendingApprovalRequests.length === 0) {
      return false;
    }

    if (this.pendingApprovalRequests.length > 0 && this.rpcSocket) {
      for (const request of this.pendingApprovalRequests) {
        await this.respondToApprovalRequest(request, action);
      }
      this.clearPendingApprovalState();
      this.setStatus("busy");
      return true;
    }

    return await super.resolveApproval(action);
  }

  override async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    if (this.pendingApprovalRequests.length === 0 && !this.pendingApproval) {
      return 0;
    }

    if (this.pendingApprovalRequests.length > 0 && this.rpcSocket) {
      const count = this.pendingApprovalRequests.length;
      for (const request of this.pendingApprovalRequests) {
        await this.respondToApprovalRequest(request, action);
      }
      this.clearPendingApprovalState();
      this.setStatus("busy");
      return count;
    }

    const ok = await super.resolveApproval(action);
    return ok ? 1 : 0;
  }

  override async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    if (!this.pendingUserInputRequest) {
      return false;
    }

    const request = this.pendingUserInputRequest;
    const responseAnswers: Record<string, { answers: string[] }> = {};
    for (const [questionId, values] of Object.entries(answers)) {
      responseAnswers[questionId] = {
        answers: values,
      };
    }

    this.sendRpcMessage({
      id: request.requestId,
      result: {
        answers: responseAnswers,
      },
    });
    this.clearPendingUserInputState();
    this.setStatus("busy", "Codex user input submitted.");
    return true;
  }

  override async dispose(): Promise<void> {
    await this.shutdownVisibleClient();
    this.resetTurnTracking({ preserveThread: false });
    if (this.isEmbeddedCliMode()) {
      this.detachLocalInputForwarding();
    }
    this.stopSessionPolling();
    if (this.isNativePanelMode()) {
      this.cleanPanelExitInProgress = true;
    }
    await this.disconnectRpcClient();
    if (this.isNativePanelMode()) {
      await this.stopNativeClient();
      this.clearCompletionTimer();
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.status = "stopped";
      this.state.pid = undefined;
      this.state.startedAt = undefined;
    } else if (this.isHeadlessRuntimeMode()) {
      this.clearCompletionTimer();
      this.clearInterruptTimer();
      this.clearPendingApprovalState();
      this.state.status = "stopped";
      this.state.pid = undefined;
      this.state.startedAt = undefined;
    } else {
      await super.dispose();
    }
    await this.stopAppServer();
  }

  private async shutdownVisibleClient(): Promise<void> {
    const endpoint = readLocalCompanionEndpoint(this.options.cwd, { adapter: "codex" });
    if (
      !endpoint?.companionPid ||
      endpoint.instanceId !== this.localClientInstanceId ||
      !endpoint.codexControlPort ||
      !endpoint.codexControlToken
    ) {
      return;
    }

    try {
      await requestCodexVisibleClientShutdown({
        cwd: this.options.cwd,
        instanceId: endpoint.instanceId,
      });
    } catch {
      // The visible client may already be exiting. Its endpoint is cleared
      // by the supervisor when the child process finishes.
    }
  }

  getLocalClientEndpoint(): LocalClientEndpoint | null {
    if (!this.isHeadlessRuntimeMode() || !this.appServerPort || !this.appServerAuthToken) {
      return null;
    }

    return {
      protocolVersion: LOCAL_CLIENT_PROTOCOL_VERSION,
      runtimeKind: this.runtimeKind,
      instanceId: this.localClientInstanceId,
      kind: this.options.kind,
      port: this.appServerPort,
      token: this.appServerAuthToken,
      renderMode: "headless",
      bridgeOwnerPid: process.pid,
      serverPort: this.appServerPort,
      serverUrl: `ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`,
      remoteAuthTokenEnv: CODEX_REMOTE_AUTH_TOKEN_ENV,
      cwd: this.options.cwd,
      command: this.options.command,
      profile: this.options.profile,
      sharedSessionId: this.state.sharedSessionId,
      sharedThreadId: this.state.sharedThreadId,
      codexVisibleThreadId: this.state.sharedThreadId,
      resumeConversationId: this.state.resumeConversationId,
      transcriptPath: this.state.transcriptPath,
      startedAt: this.state.startedAt ?? nowIso(),
    };
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    const approval = detectCliApproval(text);

    if (this.hasAcceptedInput) {
      if (approval && !this.pendingApproval) {
        this.pendingApproval = approval;
        this.state.pendingApproval = approval;
        this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
        this.setStatus("awaiting_approval", "Codex approval is required.");
        this.emit({
          type: "approval_required",
          request: approval,
          timestamp: nowIso(),
        });
      }
      return;
    }

    if (approval) {
      this.startupBlocker = approval.commandPreview;
      if (this.state.status !== "awaiting_approval") {
        this.setStatus("awaiting_approval", "Codex is waiting for local terminal input.");
      }
      return;
    }

    if (this.startupBlocker) {
      this.startupBlocker = null;
      if (this.state.status === "awaiting_approval") {
        this.setStatus("idle", "codex adapter is ready.");
      }
    }
  }

  protected override handleExit(exitCode: number | undefined): void {
    this.resetTurnTracking({ preserveThread: false });
    this.detachLocalInputForwarding();
    this.stopSessionPolling();
    void this.disconnectRpcClient();
    void this.stopAppServer();
    super.handleExit(exitCode);
  }

  private isNativePanelMode(): boolean {
    return this.options.renderMode === "panel";
  }

  private isHeadlessRuntimeMode(): boolean {
    return this.options.renderMode === "headless";
  }

  private isEmbeddedCliMode(): boolean {
    return !this.isNativePanelMode() && !this.isHeadlessRuntimeMode();
  }

  private usesRpcTurnTransport(): boolean {
    return this.isNativePanelMode() || this.isHeadlessRuntimeMode();
  }

  private isCodexClientRunning(): boolean {
    if (this.isHeadlessRuntimeMode()) {
      return Boolean(this.appServer);
    }
    return this.isNativePanelMode() ? Boolean(this.nativeProcess) : Boolean(this.pty);
  }

  private detectCodexCliVersion(): string | null {
    try {
      const target = resolveSpawnTarget(this.options.command, "codex", {
        forwardArgs: ["--version"],
      });
      const result = spawnSync(target.file, target.args, {
        cwd: this.options.cwd,
        env: this.buildEnv(),
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      return parseCodexCliVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    } catch {
      return null;
    }
  }

  private shouldPollSessionLog(): boolean {
    return (
      this.isCodexClientRunning() ||
      this.pendingTurnStart ||
      Boolean(this.activeTurn) ||
      Boolean(this.state.activeTurnId) ||
      Boolean(this.sessionFilePath)
    );
  }

  private async startNativeClient(): Promise<void> {
    this.setStatus("starting", `Starting ${this.options.kind} adapter...`);

    let spawnTarget: SpawnTarget | null = null;
    try {
      spawnTarget = resolveSpawnTarget(this.options.command, this.options.kind);
      const child = spawnChild(
        spawnTarget.file,
        [...spawnTarget.args, ...this.buildSpawnArgs()],
        {
          cwd: this.options.cwd,
          env: this.buildEnv(),
          stdio: "inherit",
          windowsHide: false,
        },
      );

      this.nativeProcess = child;
      this.shuttingDown = false;
      this.cleanPanelExitInProgress = false;
      this.hasAcceptedInput = false;
      this.state.pid = child.pid ?? undefined;
      this.state.startedAt = nowIso();
      this.state.status = "idle";
      this.state.pendingApproval = null;

      child.once("error", (error) => {
        if (this.nativeProcess === child) {
          this.handleNativeExit(undefined, undefined, error);
        }
      });
      child.once("exit", (exitCode, signal) => {
        if (this.nativeProcess === child) {
          this.handleNativeExit(exitCode ?? undefined, signal ?? undefined);
        }
      });

      this.afterStart();
      this.setStatus("idle", `${this.options.kind} adapter is ready.`);
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start ${this.options.kind}${spawnTarget ? ` (${spawnTarget.file})` : ""}: ${String(err)}`,
        timestamp: nowIso(),
      });
      throw err;
    }
  }

  private handleNativeExit(
    exitCode: number | undefined,
    signal?: NodeJS.Signals,
    startupError?: Error,
  ): void {
    const expectedShutdown = shouldTreatCodexNativeExitAsExpected({
      renderMode: this.options.renderMode,
      shuttingDown: this.shuttingDown,
      exitCode,
      signal,
      startupError,
    });
    if (expectedShutdown && this.isNativePanelMode()) {
      this.cleanPanelExitInProgress = true;
    }

    this.clearCompletionTimer();
    this.resetTurnTracking({ preserveThread: false });
    this.stopSessionPolling();
    void this.disconnectRpcClient();
    void this.stopAppServer();

    this.shuttingDown = false;
    this.nativeProcess = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (expectedShutdown) {
      this.emit({
        type: "status",
        status: "stopped",
        message: `${this.options.kind} worker stopped.`,
        timestamp: nowIso(),
      });
      return;
    }

    const exitLabel = startupError
      ? startupError.message
      : signal
        ? `signal ${signal}`
        : typeof exitCode === "number"
          ? `code ${exitCode}`
          : "an unknown code";
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} worker exited unexpectedly with ${exitLabel}.`,
      timestamp: nowIso(),
    });
  }

  private async stopNativeClient(): Promise<void> {
    if (!this.nativeProcess) {
      this.state.pid = undefined;
      return;
    }

    const child = this.nativeProcess;
    this.shuttingDown = true;
    this.nativeProcess = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        if (child.pid) {
          killProcessTreeSync(child.pid);
        } else {
          child.kill();
        }
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_500);
      timer.unref?.();
    });
  }

  private startSessionPolling(): void {
    this.stopSessionPolling();
    const poll = () => {
      void this.pollSessionLog();
    };
    this.sessionPollTimer = setInterval(poll, CODEX_SESSION_POLL_INTERVAL_MS);
    this.sessionPollTimer.unref?.();
    poll();
  }

  private stopSessionPolling(): void {
    if (this.sessionPollTimer) {
      clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = null;
    }
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.sessionIgnoreBeforeMs = null;
    this.nextSessionFallbackScanAtMs = 0;
  }

  private async pollSessionLog(): Promise<void> {
    if (!this.shouldPollSessionLog()) {
      return;
    }

    this.maybeApplyRecentSessionFallback();

    if (!this.sessionFilePath) {
      const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : Date.now();
      this.sessionFilePath = findCodexSessionFile(
        this.options.cwd,
        startedAtMs,
        { threadId: this.sharedThreadId ?? undefined },
      );
      if (!this.sessionFilePath) {
        return;
      }
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.seedSessionReplayCutoff(startedAtMs);
    }

    let chunk: string;
    try {
      const stat = fs.statSync(this.sessionFilePath);
      if (stat.size < this.sessionReadOffset) {
        this.sessionReadOffset = 0;
        this.sessionPartialLine = "";
      }
      if (stat.size === this.sessionReadOffset) {
        this.flushCompleteSessionPartialLine();
        return;
      }
      const fd = fs.openSync(this.sessionFilePath, "r");
      try {
        const bytesToRead = stat.size - this.sessionReadOffset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, this.sessionReadOffset);
        chunk = buf.toString("utf8");
        this.sessionReadOffset = stat.size;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      return;
    }

    const lines = `${this.sessionPartialLine}${chunk}`.split(/\r?\n/);
    this.sessionPartialLine = lines.pop() ?? "";

    for (const line of lines) {
      this.handleSessionLogLine(line);
    }
    this.flushCompleteSessionPartialLine();
  }

  private flushCompleteSessionPartialLine(): void {
    const line = this.sessionPartialLine.trim();
    if (!line) {
      this.sessionPartialLine = "";
      return;
    }

    try {
      JSON.parse(line);
    } catch {
      return;
    }

    this.sessionPartialLine = "";
    this.handleSessionLogLine(line);
  }

  private seedSessionReplayCutoff(startedAtMs: number): void {
    if (
      this.sessionIgnoreBeforeMs !== null ||
      this.pendingTurnStart ||
      this.activeTurn ||
      this.state.activeTurnId
    ) {
      return;
    }

    if (Number.isFinite(startedAtMs)) {
      this.sessionIgnoreBeforeMs = startedAtMs;
    }
  }

  private maybeApplyRecentSessionFallback(): void {
    if (!this.isNativePanelMode()) {
      return;
    }

    const now = Date.now();
    if (now < this.nextSessionFallbackScanAtMs) {
      return;
    }
    this.nextSessionFallbackScanAtMs = now + CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS;

    const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : now;
    const candidate = findRecentCodexSessionFileForCwd(this.options.cwd, startedAtMs);
    if (!candidate) {
      return;
    }

    let currentSessionModifiedAtMs = Number.NEGATIVE_INFINITY;
    if (this.sessionFilePath) {
      try {
        currentSessionModifiedAtMs = fs.statSync(this.sessionFilePath).mtimeMs;
      } catch {
        currentSessionModifiedAtMs = Number.NEGATIVE_INFINITY;
      }
    }

    if (candidate.threadId !== this.sharedThreadId) {
      if (this.sessionFilePath && candidate.modifiedAtMs <= currentSessionModifiedAtMs) {
        return;
      }

      if (
        !this.activeTurn ||
        this.activeTurn.threadId === candidate.threadId ||
        this.activeTurn.origin === "wechat"
      ) {
        this.trackLocalSharedThread(candidate.threadId, {
          reason: "local_session_fallback",
          signal: "session_fallback",
        });
        this.pendingThreadFollowId = null;
      } else {
        this.pendingThreadFollowId = candidate.threadId;
      }
    }

    if (this.sessionFilePath !== candidate.filePath) {
      this.sessionFilePath = candidate.filePath;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
      this.seedSessionReplayCutoff(startedAtMs);
    }
  }

  private handleSessionLogLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!isRecord(parsed) || !isRecord(parsed.payload) || typeof parsed.payload.type !== "string") {
      return;
    }

    if (shouldIgnoreCodexSessionReplayEntry(parsed.timestamp, this.sessionIgnoreBeforeMs)) {
      return;
    }

    const payload = parsed.payload;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : nowIso();
    if (this.sessionIgnoreBeforeMs !== null) {
      this.sessionIgnoreBeforeMs = null;
    }

    switch (payload.type) {
      case "task_started": {
        if (typeof payload.turn_id === "string") {
          this.recordTurnActivity(payload.turn_id, timestamp);
          this.hasAcceptedInput = true;
          this.state.activeTurnId = payload.turn_id;
          const hasTrackedTurnContext =
            this.pendingTurnStart ||
            Boolean(this.activeTurn) ||
            this.state.activeTurnOrigin === "local" ||
            this.state.activeTurnOrigin === "wechat";
          if (
            hasTrackedTurnContext &&
            this.state.status !== "busy" &&
            this.state.status !== "awaiting_approval"
          ) {
            const message =
              this.state.activeTurnOrigin === "local"
                ? "Codex is busy with a local terminal turn."
                : undefined;
            this.setStatus("busy", message);
          }
        }
        return;
      }

      case "user_message": {
        if (typeof payload.message !== "string") {
          return;
        }

        const message = normalizeOutput(payload.message).trim();
        if (!message) {
          return;
        }

        this.hasAcceptedInput = true;
        this.state.lastInputAt = timestamp;
        const origin = this.consumeInjectedInput(message) ? "wechat" : "local";
        this.state.activeTurnOrigin = origin;

        if (origin === "local") {
          const turnId = this.activeTurn?.turnId ?? this.state.activeTurnId ?? null;
          if (turnId && !this.mirroredUserInputTurnIds.has(turnId)) {
            this.mirroredUserInputTurnIds.add(turnId);
            this.emit({
              type: "mirrored_user_input",
              text: message,
              timestamp,
              origin: "local",
            });
          }

          if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
            this.setStatus("busy", "Codex is busy with a local terminal turn.");
          }

          if (
            !turnId &&
            !this.isRpcSocketOpen() &&
            isRecentIsoTimestamp(timestamp, CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS)
          ) {
            this.emit({
              type: "mirrored_user_input",
              text: message,
              timestamp,
              origin: "local",
            });
          }
        }
        return;
      }

      case "agent_message": {
        if (payload.phase !== "final_answer" || typeof payload.message !== "string") {
          return;
        }

        const message = normalizeOutput(payload.message).trim();
        if (message) {
          this.sessionFinalText = message;
          this.state.lastOutputAt = timestamp;
          const activeTurnId = this.activeTurn?.turnId ?? this.state.activeTurnId ?? null;
          if (activeTurnId) {
            this.recordTurnActivity(activeTurnId, timestamp);
            this.scheduleFinalReplyCompletionIfEligible(activeTurnId);
          }
        }
        return;
      }

      case "task_complete": {
        if (typeof payload.turn_id !== "string") {
          return;
        }
        this.clearFinalReplyCompletionTimerForTurn(payload.turn_id);

        if (this.hasCompletedTurn(payload.turn_id)) {
          this.sessionFinalText = null;
          if (this.activeTurn?.turnId === payload.turn_id) {
            this.setActiveTurn(null);
          }
          this.cleanupTurnArtifacts(payload.turn_id);
          if (this.state.status !== "stopped") {
            this.setStatus("idle");
          }
          return;
        }

        const finalText =
          this.sessionFinalText ||
          (typeof payload.last_agent_message === "string"
            ? normalizeOutput(payload.last_agent_message).trim()
            : "");
        const completionOrigin =
          this.activeTurn?.turnId === payload.turn_id
            ? this.activeTurn.origin
            : this.state.activeTurnOrigin;
        this.sessionFinalText = null;

        if (this.activeTurn?.turnId === payload.turn_id) {
          this.setActiveTurn(null);
        } else if (this.state.activeTurnId === payload.turn_id) {
          this.state.activeTurnId = undefined;
          this.state.activeTurnOrigin = undefined;
        }

        this.clearPendingApprovalState();
        this.cleanupTurnArtifacts(payload.turn_id);

        if (this.state.status !== "stopped") {
          this.setStatus("idle");
        }

        if (finalText) {
          this.emit({
            type: "final_reply",
            text: finalText,
            timestamp,
          });
        }

        this.emit({
          type: "task_complete",
          summary:
            completionOrigin === "local"
              ? "Local terminal turn completed."
              : this.currentPreview,
          timestamp,
        });

        this.rememberCompletedTurn(payload.turn_id);
        return;
      }
    }
  }

  private rememberInjectedInput(text: string): void {
    const normalizedText = normalizeOutput(text).trim();
    if (!normalizedText) {
      return;
    }

    const cutoff = Date.now() - 60_000;
    this.pendingInjectedInputs = this.pendingInjectedInputs.filter(
      (entry) => entry.createdAtMs >= cutoff,
    );
    this.pendingInjectedInputs.push({
      text,
      normalizedText,
      createdAtMs: Date.now(),
    });
    if (this.pendingInjectedInputs.length > 8) {
      this.pendingInjectedInputs.splice(0, this.pendingInjectedInputs.length - 8);
    }
  }

  private consumeInjectedInput(message: string): boolean {
    const normalizedMessage = normalizeOutput(message).trim();
    if (!normalizedMessage) {
      return false;
    }

    const cutoff = Date.now() - 60_000;
    this.pendingInjectedInputs = this.pendingInjectedInputs.filter(
      (entry) => entry.createdAtMs >= cutoff,
    );

    const index = this.pendingInjectedInputs.findIndex(
      (entry) => entry.normalizedText === normalizedMessage,
    );
    if (index < 0) {
      return false;
    }

    this.pendingInjectedInputs.splice(index, 1);
    return true;
  }

  private async typeIntoPty(text: string): Promise<void> {
    for (const character of text) {
      this.writeToPty(character);
      await delay(4);
    }
  }

  private async sendPanelTurn(text: string): Promise<void> {
    if (this.isNativePanelMode() && !this.nativeProcess) {
      throw new Error("codex panel is not running.");
    }
    this.recoverStaleBusyStateIfNeeded();
    this.recoverStaleActiveTurnStateIfNeeded();
    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm or /deny.");
    }
    if (this.pendingUserInputRequest || this.state.pendingUserInput) {
      throw new Error("Codex is waiting for user input. Reply with /answer and your response, or use /stop.");
    }
    if (this.pendingTurnStart || this.activeTurn || this.state.status === "busy") {
      const origin = this.state.activeTurnOrigin;
      if (origin === "local") {
        throw new Error("The local Codex panel is still working. Wait for the current reply or use /stop.");
      }
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.rememberInjectedInput(text);
    this.clearPendingApprovalState();

    const threadId = await this.ensureThreadStarted();
    const subscribedBeforeTurnStart = await this.tryEnsureSharedThreadSubscribed(threadId);
    this.pendingTurnStart = true;
    this.pendingTurnThreadId = threadId;
    this.interruptPendingTurnStart = false;
    this.state.activeTurnOrigin = "wechat";
    this.setStatus("busy");

    try {
      const response = await this.sendRpcRequest("turn/start", {
        threadId,
        cwd: this.options.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        input: [
          {
            type: "text",
            text,
          },
        ],
      });

      const turnId = this.extractTurnIdFromResponse(response);
      if (!turnId) {
        throw new Error("Codex did not return a turn id for the requested turn.");
      }

      this.bindActiveTurn({
        threadId,
        turnId,
        origin: "wechat",
      });
      if (!subscribedBeforeTurnStart) {
        await this.tryEnsureSharedThreadSubscribed(threadId);
      }

      if (this.interruptPendingTurnStart) {
        await this.requestActiveTurnInterrupt();
        this.armInterruptFallback();
      }
    } catch (error) {
      this.pendingTurnStart = false;
      this.pendingTurnThreadId = null;
      this.interruptPendingTurnStart = false;
      this.state.activeTurnOrigin = undefined;
      if (!this.activeTurn && this.getState().status === "busy") {
        this.setStatus("idle");
      }
      throw error;
    }
  }

  private async interruptPanelTurn(): Promise<boolean> {
    if (this.isNativePanelMode() && !this.nativeProcess) {
      return false;
    }

    const turnPending =
      this.pendingTurnStart ||
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.state.status === "awaiting_input";
    if (!turnPending) {
      return false;
    }

    this.clearPendingApprovalState();
    this.clearPendingUserInputState();

    if (this.pendingTurnStart && !this.activeTurn) {
      this.interruptPendingTurnStart = true;
      this.armInterruptFallback();
      return true;
    }

    if (!this.activeTurn) {
      return false;
    }

    await this.requestActiveTurnInterrupt();
    this.armInterruptFallback();
    return true;
  }

  private async startAppServer(): Promise<void> {
    if (this.appServer) {
      return;
    }

    const port = await reserveLocalPort();
    const env = this.buildEnv();
    const workspacePaths = ensureWorkspaceChannelDir(this.options.cwd);
    const token = crypto.randomBytes(24).toString("hex");
    const tokenFilePath = path.join(
      workspacePaths.workspaceDir,
      `codex-app-server-token-${this.localClientInstanceId}.txt`,
    );
    fs.writeFileSync(tokenFilePath, `${token}\n`, "utf8");
    const spawnTarget = resolveSpawnTarget(this.options.command, "codex");
    const child = spawnChild(
      spawnTarget.file,
      [
        ...spawnTarget.args,
        "app-server",
        "--listen",
        `ws://${CODEX_APP_SERVER_HOST}:${port}`,
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        tokenFilePath,
      ],
      {
        cwd: this.options.cwd,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );

    this.appServer = child;
    this.appServerPort = port;
    this.appServerShuttingDown = false;
    this.appServerLog = "";
    this.appServerAuthToken = token;
    this.appServerAuthTokenFilePath = tokenFilePath;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.once("error", (error: Error) => {
      // spawn itself failed (ENOENT/EACCES/EMFILE). Without this listener the
      // 'error' event is unhandled and crashes the bridge. Mirror the exit
      // handler's cleanup so the failure surfaces as a fatal_error instead.
      const expectedShutdown = shouldSuppressCodexTransportFatalError({
        transportShuttingDown: this.appServerShuttingDown,
        shuttingDown: this.shuttingDown,
        cleanPanelExitInProgress: this.cleanPanelExitInProgress,
      });
      this.appServer = null;
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      this.deleteAppServerAuthTokenFile();
      this.appServerAuthToken = null;
      if (expectedShutdown) {
        return;
      }
      const details = this.describeAppServerLog();
      this.emit({
        type: "fatal_error",
        message: `codex app-server failed to start: ${String(error)}${details}`,
        timestamp: nowIso(),
      });
      this.terminateCodexClient();
    });
    child.on("exit", (code, signal) => {
      const expectedShutdown = shouldSuppressCodexTransportFatalError({
        transportShuttingDown: this.appServerShuttingDown,
        shuttingDown: this.shuttingDown,
        cleanPanelExitInProgress: this.cleanPanelExitInProgress,
      });
      this.appServer = null;
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      this.deleteAppServerAuthTokenFile();
      this.appServerAuthToken = null;

      if (expectedShutdown) {
        return;
      }

      const exitLabel =
        signal ? `signal ${signal}` : `code ${typeof code === "number" ? code : "unknown"}`;
      const details = this.describeAppServerLog();
      this.emit({
        type: "fatal_error",
        message: `codex app-server exited unexpectedly with ${exitLabel}.${details}`,
        timestamp: nowIso(),
      });

      this.terminateCodexClient();
    });

    try {
      await waitForTcpPort(
        CODEX_APP_SERVER_HOST,
        port,
        CODEX_APP_SERVER_READY_TIMEOUT_MS,
      );
    } catch (err) {
      await this.stopAppServer();
      const details = this.describeAppServerLog();
      throw new Error(`Failed to start Codex app-server: ${String(err)}${details}`, {
        cause: err,
      });
    }
  }

  private async connectRpcClient(): Promise<void> {
    if (this.rpcSocket) {
      return;
    }
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable in this runtime.");
    }

    const url = `ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`;
    const deadline = Date.now() + CODEX_APP_SERVER_READY_TIMEOUT_MS;
    let lastError = "Timed out before the websocket became ready.";

    while (Date.now() < deadline) {
      try {
        const socket = await this.openRpcSocket(
          url,
          this.appServerAuthToken,
          deadline - Date.now(),
        );
        this.attachRpcSocket(socket);
        await this.initializeRpcClient();
        return;
      } catch (err) {
        lastError = describeUnknownError(err);
        await this.disconnectRpcClient();
        await delay(CODEX_RPC_CONNECT_RETRY_MS);
      }
    }

    throw new Error(`Failed to connect to Codex app-server websocket: ${lastError}`);
  }

  private async openRpcSocket(
    url: string,
    authToken: string | null,
    timeoutMs: number,
  ): Promise<WebSocket> {
    if (!authToken) {
      throw new Error("Codex app-server websocket auth token is unavailable.");
    }

    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close();
        } catch {
          // Best effort cleanup after timeout.
        }
        reject(new Error(`Timed out opening Codex websocket ${url}.`));
      }, Math.max(500, timeoutMs));

      const cleanup = () => {
        clearTimeout(timer);
      };

      socket.addEventListener(
        "open",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(socket);
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error(`Failed to open Codex websocket ${url}.`));
        },
        { once: true },
      );
    });
  }

  private attachRpcSocket(socket: WebSocket): void {
    this.rpcSocket = socket;
    this.rpcShuttingDown = false;
    this.subscribedThreadIds.clear();

    socket.addEventListener("message", (event) => {
      this.handleRpcMessageData(event.data);
    });
    socket.addEventListener("close", (event) => {
      this.handleRpcSocketClosed(event.code, event.reason);
    });
  }

  private async disconnectRpcClient(): Promise<void> {
    const socket = this.rpcSocket;
    this.rpcSocket = null;
    this.rpcShuttingDown = true;
    this.subscribedThreadIds.clear();
    this.rejectPendingRpcRequests("Codex websocket connection closed.");

    if (!socket) {
      this.rpcShuttingDown = false;
      return;
    }

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      socket.addEventListener("close", () => finish(), { once: true });
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();

      try {
        socket.close();
      } catch {
        finish();
      }
    });

    this.rpcShuttingDown = false;
  }

  private handleRpcSocketClosed(code?: number, reason?: string): void {
    const expectedShutdown = shouldSuppressCodexTransportFatalError({
      transportShuttingDown: this.rpcShuttingDown,
      shuttingDown: this.shuttingDown,
      cleanPanelExitInProgress: this.cleanPanelExitInProgress,
    });
    this.rpcSocket = null;
    this.lastRpcCloseDetail = `close_code=${code ?? "unknown"}${reason ? ` reason=${truncatePreview(reason, 240)}` : ""}`;
    this.subscribedThreadIds.clear();
    this.rejectPendingRpcRequests("Codex websocket connection closed.");
    this.rpcShuttingDown = false;

    if (expectedShutdown) {
      return;
    }

    void this.reconnectRpcClientAfterUnexpectedClose();
  }

  private async reconnectRpcClientAfterUnexpectedClose(): Promise<boolean> {
    if (this.rpcReconnectPromise) {
      return await this.rpcReconnectPromise;
    }

    this.rpcReconnectPromise = (async () => {
      if (
        shouldSuppressCodexTransportFatalError({
          transportShuttingDown: this.rpcShuttingDown,
          shuttingDown: this.shuttingDown,
          cleanPanelExitInProgress: this.cleanPanelExitInProgress,
        })
      ) {
        return false;
      }

      if (!this.appServer || !this.appServerPort) {
        if (
          shouldSuppressCodexTransportFatalError({
            transportShuttingDown: this.appServerShuttingDown,
            shuttingDown: this.shuttingDown,
            cleanPanelExitInProgress: this.cleanPanelExitInProgress,
          })
        ) {
          return false;
        }
        const details = this.describeAppServerLog();
        this.emit({
          type: "fatal_error",
          message: `codex app-server websocket closed unexpectedly (${this.lastRpcCloseDetail || "no close details"}).${details}`,
          timestamp: nowIso(),
        });
        this.terminateCodexClient();
        return false;
      }

      const reconnectDeadline = Date.now() + CODEX_RPC_RECONNECT_TIMEOUT_MS;
      let lastError = "Codex websocket connection closed.";

      while (
        !this.shuttingDown &&
        !this.cleanPanelExitInProgress &&
        Date.now() < reconnectDeadline
      ) {
        try {
          await this.connectRpcClient();
          // The new connection starts with an empty subscription set.
          // Resubscribe the shared thread so turn notifications and approval
          // requests keep flowing: without this, a mid-turn reconnect
          // silently stops delivery, and approvals answered over the new
          // connection (with the old request id) are ignored by the server.
          if (this.state.sharedThreadId) {
            await this.tryEnsureSharedThreadSubscribed(this.state.sharedThreadId);
          }
          return true;
        } catch (error) {
          lastError = describeUnknownError(error);
          await delay(CODEX_RPC_CONNECT_RETRY_MS);
        }
      }

      const details = this.describeAppServerLog();
      if (
        shouldSuppressCodexTransportFatalError({
          transportShuttingDown: this.appServerShuttingDown,
          shuttingDown: this.shuttingDown,
          cleanPanelExitInProgress: this.cleanPanelExitInProgress,
        })
      ) {
        return false;
      }
      this.emit({
        type: "fatal_error",
        message: `codex app-server websocket closed unexpectedly and could not reconnect (${this.lastRpcCloseDetail || "no close details"}): ${lastError}.${details}`,
        timestamp: nowIso(),
      });
      this.terminateCodexClient();
      return false;
    })();

    try {
      return await this.rpcReconnectPromise;
    } finally {
      this.rpcReconnectPromise = null;
    }
  }

  private rejectPendingRpcRequests(message: string): void {
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRpcRequests.clear();
  }

  private async initializeRpcClient(): Promise<void> {
    await this.sendRpcRequest("initialize", {
      clientInfo: {
        name: "wechat-bridge",
        title: "WeChat Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
  }

  private async restoreInitialSharedThreadIfNeeded(): Promise<void> {
    if (!this.resumeThreadId || this.isNativePanelMode()) {
      return;
    }

    const threadId = this.resumeThreadId;
    this.resumeThreadId = null;

    try {
      await this.resumeSharedThread(threadId, { startup: true });
    } catch (error) {
      this.updateSharedThread(null);
      this.emit({
        type: "status",
        status: "starting",
        message: `Failed to restore the previous Codex thread ${threadId.slice(0, 12)}. Starting without resume: ${describeUnknownError(error)}`,
        timestamp: nowIso(),
      });
    }
  }

  private async ensureThreadStarted(): Promise<string> {
    if (this.sharedThreadId) {
      return this.sharedThreadId;
    }

    const response = await this.sendRpcRequest("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "wechat-bridge",
    });

    const threadId = this.extractThreadIdFromResponse(response);
    if (!threadId) {
      throw new Error("Codex did not return a thread id for the bridge session.");
    }

    this.rememberBridgeOwnedThreadSignal(threadId);
    this.subscribedThreadIds.add(threadId);
    this.updateSharedThread(threadId);
    return threadId;
  }

  private async tryEnsureSharedThreadSubscribed(threadId: string): Promise<boolean> {
    if (this.subscribedThreadIds.has(threadId)) {
      return true;
    }

    const pending = this.pendingThreadSubscriptions.get(threadId);
    if (pending) {
      return await pending;
    }

    const attempt = this.ensureSharedThreadSubscribed(threadId)
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        this.pendingThreadSubscriptions.delete(threadId);
      });
    this.pendingThreadSubscriptions.set(threadId, attempt);
    return await attempt;
  }

  private async ensureSharedThreadSubscribed(threadId: string): Promise<void> {
    if (this.subscribedThreadIds.has(threadId)) {
      return;
    }

    const response = await this.sendRpcRequest("thread/resume", {
      threadId,
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });

    const resumedThreadId = this.extractThreadIdFromResponse(response);
    if (!resumedThreadId) {
      throw new Error("Codex did not return a thread id while subscribing the bridge client.");
    }
    if (resumedThreadId !== threadId) {
      throw new Error(`Codex opened ${resumedThreadId}, expected ${threadId}.`);
    }
    this.validateCodexThreadWorkspaceIfPresent(response, threadId);

    this.rememberBridgeOwnedThreadSignal(resumedThreadId);
    this.subscribedThreadIds.add(resumedThreadId);
  }

  private async listAppServerResumeSessions(
    limit: number,
  ): Promise<BridgeResumeSessionCandidate[]> {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    const baseParams = {
      limit: boundedLimit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode"],
      archived: false,
      cwd: this.options.cwd,
    };

    try {
      const fastResponse = await this.sendRpcRequest("thread/list", {
        ...baseParams,
        useStateDbOnly: true,
      });
      const fastCandidates = buildCodexResumeCandidatesFromThreadList(
        fastResponse,
        this.options.cwd,
        boundedLimit,
      );
      if (fastCandidates.length > 0) {
        return fastCandidates;
      }
    } catch {
      // Older supported app-server builds may not understand useStateDbOnly.
      // The scan-and-repair request below is also the authoritative fallback.
    }

    const response = await this.sendRpcRequest("thread/list", baseParams);
    return buildCodexResumeCandidatesFromThreadList(
      response,
      this.options.cwd,
      boundedLimit,
    );
  }

  private validateCodexResumeThread(
    response: unknown,
    targetThreadId: string,
  ): Record<string, unknown> {
    if (!isRecord(response) || !isRecord(response.thread)) {
      throw new Error("Codex returned an invalid thread response.");
    }
    const thread = response.thread;
    if (thread.id !== targetThreadId) {
      throw new Error(
        `Codex opened ${String(thread.id)}, expected ${targetThreadId}.`,
      );
    }
    if (
      typeof thread.cwd !== "string" ||
      normalizeComparablePath(thread.cwd) !== normalizeComparablePath(this.options.cwd)
    ) {
      throw new Error(`Codex thread ${targetThreadId} does not belong to ${this.options.cwd}.`);
    }
    if (typeof thread.parentThreadId === "string") {
      throw new Error(`Codex thread ${targetThreadId} is a subagent thread and cannot be resumed.`);
    }
    if (thread.canAcceptDirectInput === false) {
      throw new Error(`Codex thread ${targetThreadId} is owned by a parent agent and cannot accept direct input.`);
    }
    if (thread.ephemeral === true) {
      throw new Error(`Codex thread ${targetThreadId} is ephemeral and cannot be resumed.`);
    }
    if (getCodexThreadStatusType(thread.status) === "active") {
      throw new Error(
        `Codex thread ${targetThreadId} is still active. Stop its running task before resuming it from WeChat.`,
      );
    }
    return thread;
  }

  private validateCodexThreadWorkspaceIfPresent(
    response: unknown,
    targetThreadId: string,
  ): void {
    if (!isRecord(response) || !isRecord(response.thread)) {
      return;
    }
    const thread = response.thread;
    if (typeof thread.id === "string" && thread.id !== targetThreadId) {
      throw new Error(`Codex opened ${thread.id}, expected ${targetThreadId}.`);
    }
    if (
      typeof thread.cwd === "string" &&
      normalizeComparablePath(thread.cwd) !== normalizeComparablePath(this.options.cwd)
    ) {
      throw new Error(`Codex thread ${targetThreadId} does not belong to ${this.options.cwd}.`);
    }
    if (typeof thread.parentThreadId === "string") {
      throw new Error(`Codex thread ${targetThreadId} is a subagent thread.`);
    }
    if (thread.canAcceptDirectInput === false) {
      throw new Error(`Codex thread ${targetThreadId} is owned by a parent agent.`);
    }
    if (thread.ephemeral === true) {
      throw new Error(`Codex thread ${targetThreadId} is ephemeral.`);
    }
  }

  private async resumeVisibleSharedThread(threadId: string): Promise<void> {
    const targetThreadId = threadId.trim();
    if (!targetThreadId) {
      throw new Error("A thread id is required to resume a Codex thread.");
    }
    if (this.pendingVisibleResume) {
      throw new Error("Codex is already switching visible threads.");
    }
    if (this.pendingApproval || this.pendingApprovalRequests.length > 0) {
      throw new Error("A Codex approval request is pending. Reply with /confirm or /deny.");
    }
    if (this.pendingUserInputRequest || this.state.pendingUserInput) {
      throw new Error("Codex is waiting for user input. Reply with /answer or use /stop.");
    }
    if (
      this.pendingTurnStart ||
      this.activeTurn ||
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.state.status === "awaiting_input"
    ) {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }
    if (this.state.status !== "idle") {
      throw new Error(`Codex cannot switch threads while its status is ${this.state.status}.`);
    }

    const previousThreadId = this.sharedThreadId;
    let targetSubscribed = false;
    this.pendingVisibleResume = { targetThreadId };
    this.setStatus("starting", `Codex resume validating thread ${targetThreadId.slice(0, 12)}...`);

    try {
      const readResponse = await this.sendRpcRequest("thread/read", {
        threadId: targetThreadId,
        includeTurns: false,
      });
      this.validateCodexResumeThread(readResponse, targetThreadId);
      this.setStatus("starting", `Codex resume validated thread ${targetThreadId.slice(0, 12)}.`);

      this.rememberBridgeOwnedThreadSignal(targetThreadId);
      this.setStatus("starting", `Codex resume requesting thread ${targetThreadId.slice(0, 12)}.`);
      const resumeResponse = await this.sendRpcRequest("thread/resume", {
        threadId: targetThreadId,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        excludeTurns: true,
      });
      targetSubscribed = true;
      this.validateCodexResumeThread(resumeResponse, targetThreadId);
      this.subscribedThreadIds.add(targetThreadId);

      this.setStatus("starting", `Codex resume switching visible thread ${targetThreadId.slice(0, 12)}.`);
      const visibleThreadId = await this.switchVisibleCodexThread(targetThreadId);
      if (visibleThreadId !== targetThreadId) {
        throw new Error(
          `The visible Codex client opened ${visibleThreadId}, expected ${targetThreadId}.`,
        );
      }

      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
      this.pendingThreadFollowId = null;
      this.updateSharedThread(targetThreadId, {
        source: "wechat",
        reason: "wechat_resume",
        notify: true,
      });
      this.bridgeResumeReplayThreadId = targetThreadId;
      this.bridgeResumeReplayUntilMs = Date.now() + CODEX_RESUME_REPLAY_SETTLE_MS;
      this.setStatus("starting", `Codex resume committed thread ${targetThreadId.slice(0, 12)}.`);
      this.setStatus("idle");

      if (previousThreadId && previousThreadId !== targetThreadId) {
        await this.unsubscribeCodexThreadBestEffort(previousThreadId);
      }
    } catch (error) {
      if (targetSubscribed && targetThreadId !== previousThreadId) {
        await this.unsubscribeCodexThreadBestEffort(targetThreadId);
      }
      this.setStatus(
        "idle",
        `Codex resume failed for ${targetThreadId.slice(0, 12)}: ${describeUnknownError(error)}`,
      );
      throw error;
    } finally {
      this.pendingVisibleResume = null;
    }
  }

  private async switchVisibleCodexThread(threadId: string): Promise<string> {
    return await requestCodexVisibleThreadSwitch({
      cwd: this.options.cwd,
      instanceId: this.localClientInstanceId,
      threadId,
    });
  }

  private async unsubscribeCodexThreadBestEffort(threadId: string): Promise<void> {
    try {
      await this.sendRpcRequest("thread/unsubscribe", { threadId });
      this.subscribedThreadIds.delete(threadId);
    } catch {
      // A failed unsubscribe must not undo an otherwise successful visible switch.
    }
  }

  private async resumeSharedThread(
    threadId: string,
    options: { startup?: boolean } = {},
  ): Promise<void> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      throw new Error("A thread id is required to resume a Codex thread.");
    }

    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm or /deny.");
    }

    if (
      !options.startup &&
      (this.pendingTurnStart ||
        this.activeTurn ||
        this.state.status === "busy" ||
        this.state.status === "awaiting_approval")
    ) {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }

    const response = await this.sendRpcRequest("thread/resume", {
      threadId: trimmedThreadId,
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });

    const resumedThreadId = this.extractThreadIdFromResponse(response);
    if (!resumedThreadId) {
      throw new Error("Codex did not return a thread id while resuming the saved thread.");
    }
    this.validateCodexThreadWorkspaceIfPresent(response, resumedThreadId);

    this.rememberBridgeOwnedThreadSignal(resumedThreadId);
    this.subscribedThreadIds.add(resumedThreadId);
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.pendingThreadFollowId = null;
    this.updateSharedThread(resumedThreadId, {
      source: options.startup ? "restore" : "wechat",
      reason: options.startup ? "startup_restore" : "wechat_resume",
      notify: true,
    });
  }

  private extractThreadIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.thread)) {
      return null;
    }
    return typeof response.thread.id === "string" ? response.thread.id : null;
  }

  private extractTurnIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.turn)) {
      return null;
    }
    return typeof response.turn.id === "string" ? response.turn.id : null;
  }

  private bindActiveTurn(activeTurn: CodexActiveTurn): void {
    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.bridgeOwnedTurnIds.add(activeTurn.turnId);
    this.setActiveTurn(activeTurn);

    const queuedNotifications = this.queuedTurnNotifications;
    this.queuedTurnNotifications = [];
    for (const notification of queuedNotifications) {
      this.handleRpcNotification(notification.method, notification.params);
    }

    const queuedRequests = this.queuedTurnServerRequests;
    this.queuedTurnServerRequests = [];
    for (const request of queuedRequests) {
      this.handleRpcServerRequest(request.requestId, request.method, request.params);
    }
  }

  private async requestActiveTurnInterrupt(): Promise<void> {
    if (!this.activeTurn) {
      return;
    }

    await this.sendRpcRequest("turn/interrupt", {
      threadId: this.activeTurn.threadId,
      turnId: this.activeTurn.turnId,
    });
  }

  private armInterruptFallback(): void {
    this.clearInterruptTimer();
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (
        this.state.status !== "busy" &&
        this.state.status !== "awaiting_approval" &&
        this.state.status !== "awaiting_input"
      ) {
        return;
      }

      // Remember the interrupted turn as completed before resetting: the
      // server may still deliver a late turn/completed for it, and without
      // this entry it would be tracked as a brand-new local turn — emitting a
      // duplicate task_complete (or a ghost reply) for work we already
      // reported as interrupted.
      const interruptedTurnId = this.activeTurn?.turnId;
      this.resetTurnTracking({
        preserveThread: true,
        preserveCompletedTurns: true,
      });
      if (interruptedTurnId) {
        this.rememberCompletedTurn(interruptedTurnId);
        this.bridgeOwnedTurnIds.add(interruptedTurnId);
      }
      this.setStatus("idle", "Codex task interrupted.");
      this.emit({
        type: "task_complete",
        summary: "Interrupted",
        timestamp: nowIso(),
      });
    }, INTERRUPT_SETTLE_DELAY_MS);
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimer) {
      return;
    }
    clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }

  private recoverStaleBusyStateIfNeeded(): void {
    if (
      !shouldRecoverCodexStaleBusyState({
        status: this.state.status,
        pendingTurnStart: this.pendingTurnStart,
        hasActiveTurn: Boolean(this.activeTurn),
        hasPendingApproval: Boolean(this.pendingApproval || this.pendingApprovalRequests.length),
        hasPendingUserInput: Boolean(this.pendingUserInputRequest || this.state.pendingUserInput),
        activeTurnId: this.state.activeTurnId,
      })
    ) {
      return;
    }

    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.interruptPendingTurnStart = false;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
    this.clearInterruptTimer();
    this.setStatus("idle", "Recovered stale busy state.");
  }

  private recoverStaleActiveTurnStateIfNeeded(): void {
    if (
      !this.activeTurn ||
      this.pendingTurnStart ||
      this.pendingApproval ||
      this.pendingApprovalRequests.length ||
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.state.activeTurnId
    ) {
      return;
    }

    this.cleanupTurnArtifacts(this.activeTurn.turnId);
    this.setActiveTurn(null);
    this.clearInterruptTimer();
  }

  private resetTurnTracking(options: {
    preserveThread: boolean;
    /** Keep completed/bridge-owned turn dedup sets (interrupt fallback). */
    preserveCompletedTurns?: boolean;
  }): void {
    this.clearInterruptTimer();
    this.clearFinalReplyCompletionTimer();
    if (this.activeTurn) {
      this.cleanupTurnArtifacts(this.activeTurn.turnId);
    }
    this.setActiveTurn(null);
    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.interruptPendingTurnStart = false;
    this.pendingThreadFollowId = null;
    this.clearPendingApprovalState();
    this.clearPendingUserInputState();
    this.queuedTurnNotifications = [];
    this.queuedTurnServerRequests = [];
    this.turnFinalMessages.clear();
    this.turnDeltaByItem.clear();
    this.turnErrorById.clear();
    this.turnLastActivityAtMs.clear();
    this.mirroredUserInputTurnIds.clear();
    if (!options.preserveCompletedTurns) {
      this.bridgeOwnedTurnIds.clear();
      this.completedTurnIds.clear();
      this.completedTurnOrder = [];
    }
    this.pendingInjectedInputs = [];
    this.threadStatusCheckEpoch += 1;
    this.pendingThreadStatusChecks.clear();
    this.clearBridgeResumeReplay();
    this.recentBridgeThreadSignalAtById.clear();
    this.sessionFinalText = null;
    this.nextSessionFallbackScanAtMs = 0;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
    if (!options.preserveThread) {
      this.clearPendingThreadAnnouncement();
      this.announcedThreadId = null;
    }
    if (!options.preserveThread) {
      this.updateSharedThread(null);
    }
  }

  private updateSharedThread(
    threadId: string | null,
    options: {
      source?: BridgeThreadSwitchSource;
      reason?: BridgeThreadSwitchReason;
      notify?: boolean;
    } = {},
  ): void {
    const previousThreadId = this.sharedThreadId;
    this.sharedThreadId = threadId;
    this.state.sharedSessionId = threadId ?? undefined;
    this.state.sharedThreadId = threadId ?? undefined;
    if (!threadId) {
      this.clearPendingThreadAnnouncement();
      this.announcedThreadId = null;
    } else if (
      previousThreadId !== threadId &&
      this.pendingThreadAnnouncement &&
      this.pendingThreadAnnouncement.threadId !== threadId
    ) {
      this.clearPendingThreadAnnouncement();
    }
    if (threadId && options.source && options.reason) {
      const switchedAt = nowIso();
      this.state.lastSessionSwitchAt = switchedAt;
      this.state.lastSessionSwitchSource = options.source;
      this.state.lastSessionSwitchReason = options.reason;
      this.state.lastThreadSwitchAt = switchedAt;
      this.state.lastThreadSwitchSource = options.source;
      this.state.lastThreadSwitchReason = options.reason;
      if (options.notify) {
        this.emitThreadSwitched(threadId, options.source, options.reason);
      }
    }
    if (previousThreadId !== threadId) {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
      this.sessionIgnoreBeforeMs = threadId ? Date.now() : null;
      this.nextSessionFallbackScanAtMs = 0;
      this.emit({
        type: "status",
        status: this.state.status,
        timestamp: nowIso(),
      });
    }
  }

  private setActiveTurn(activeTurn: CodexActiveTurn | null): void {
    this.activeTurn = activeTurn;
    this.state.activeTurnId = activeTurn?.turnId;
    this.state.activeTurnOrigin = activeTurn?.origin;
    if (!activeTurn && this.pendingThreadFollowId) {
      const pendingThreadId = this.pendingThreadFollowId;
      this.pendingThreadFollowId = null;
      this.trackLocalSharedThread(pendingThreadId, {
        reason: "local_follow",
        signal: "status_changed",
      });
    }
  }

  private blockLateLocalThreadFollow(): void {
    this.localThreadFollowBlockedUntilMs =
      Date.now() + CODEX_LOCAL_THREAD_ANNOUNCE_SETTLE_MS;
  }

  private clearPendingThreadAnnouncement(): void {
    if (!this.pendingThreadAnnouncement) {
      return;
    }
    if (this.pendingThreadAnnouncement.timer) {
      clearTimeout(this.pendingThreadAnnouncement.timer);
    }
    this.pendingThreadAnnouncement = null;
  }

  private emitThreadSwitched(
    threadId: string,
    source: BridgeThreadSwitchSource,
    reason: BridgeThreadSwitchReason,
  ): void {
    if (this.announcedThreadId === threadId) {
      if (this.pendingThreadAnnouncement?.threadId === threadId) {
        this.clearPendingThreadAnnouncement();
      }
      return;
    }

    if (this.pendingThreadAnnouncement?.threadId === threadId) {
      this.clearPendingThreadAnnouncement();
    }

    const switchedAt = nowIso();
    this.announcedThreadId = threadId;
    this.state.lastSessionSwitchAt = switchedAt;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    this.state.lastThreadSwitchAt = switchedAt;
    this.state.lastThreadSwitchSource = source;
    this.state.lastThreadSwitchReason = reason;
    this.emit({
      type: "thread_switched",
      threadId,
      source,
      reason,
      timestamp: switchedAt,
    });
  }

  private isPendingThreadAnnouncementStable(
    pending: CodexPendingThreadAnnouncement,
  ): boolean {
    return pending.signals.has("user_message") || pending.signals.size >= 2;
  }

  private schedulePendingThreadAnnouncement(): void {
    const pending = this.pendingThreadAnnouncement;
    if (!pending || pending.timer || !this.isNativePanelMode()) {
      return;
    }

    pending.timer = setTimeout(() => {
      const current = this.pendingThreadAnnouncement;
      if (!current || current.threadId !== pending.threadId) {
        return;
      }
      current.timer = null;
      this.updateSharedThread(current.threadId, {
        source: current.source,
        reason: current.reason,
        notify: true,
      });
    }, CODEX_LOCAL_THREAD_ANNOUNCE_SETTLE_MS);
    pending.timer.unref?.();
  }

  private trackLocalSharedThread(
    threadId: string,
    options: {
      reason: BridgeThreadSwitchReason;
      signal: CodexThreadAnnouncementSignal;
    },
  ): void {
    const weakSignal =
      options.signal === "status_changed" ||
      options.signal === "thread_started" ||
      options.signal === "session_fallback";
    if (weakSignal && Date.now() < this.localThreadFollowBlockedUntilMs) {
      return;
    }
    if (options.signal === "user_message" || options.signal === "turn_started") {
      this.localThreadFollowBlockedUntilMs = 0;
    }

    if (this.pendingVisibleResume) {
      return;
    }

    this.interruptWechatTurnForLocalThreadSwitch(threadId);

    if (!this.isNativePanelMode()) {
      const threadChanged = this.sharedThreadId !== threadId;
      this.updateSharedThread(threadId, {
        source: "local",
        reason: options.reason,
        notify: true,
      });
      if (threadChanged) {
        void this.tryEnsureSharedThreadSubscribed(threadId);
      }
      return;
    }

    this.updateSharedThread(threadId, {
      source: "local",
      reason: options.reason,
    });

    if (this.announcedThreadId === threadId) {
      if (this.pendingThreadAnnouncement?.threadId === threadId) {
        this.clearPendingThreadAnnouncement();
      }
      return;
    }

    if (!this.pendingThreadAnnouncement || this.pendingThreadAnnouncement.threadId !== threadId) {
      this.clearPendingThreadAnnouncement();
      this.pendingThreadAnnouncement = {
        threadId,
        source: "local",
        reason: options.reason,
        signals: new Set<CodexThreadAnnouncementSignal>(),
        timer: null,
      };
    }

    this.pendingThreadAnnouncement.source = "local";
    this.pendingThreadAnnouncement.reason = options.reason;
    this.pendingThreadAnnouncement.signals.add(options.signal);

    if (this.isPendingThreadAnnouncementStable(this.pendingThreadAnnouncement)) {
      this.updateSharedThread(threadId, {
        source: "local",
        reason: options.reason,
        notify: true,
      });
      return;
    }

    this.schedulePendingThreadAnnouncement();
  }

  private interruptWechatTurnForLocalThreadSwitch(nextThreadId: string): void {
    const activeTurn = this.activeTurn;
    if (
      !activeTurn ||
      activeTurn.origin !== "wechat" ||
      activeTurn.threadId === nextThreadId
    ) {
      return;
    }

    const interruptedTurnId = activeTurn.turnId;
    void this.sendRpcRequest("turn/interrupt", {
      threadId: activeTurn.threadId,
      turnId: interruptedTurnId,
    }).catch(() => undefined);

    this.clearInterruptTimer();
    this.clearFinalReplyCompletionTimerForTurn(interruptedTurnId);
    this.clearPendingApprovalState();
    this.clearPendingUserInputState();
    this.pendingThreadFollowId = null;
    this.cleanupTurnArtifacts(interruptedTurnId);
    this.rememberCompletedTurn(interruptedTurnId);
    this.bridgeOwnedTurnIds.add(interruptedTurnId);
    this.setActiveTurn(null);
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message:
        "The active WeChat task was interrupted because the local Codex terminal switched threads.",
      timestamp: nowIso(),
    });
  }

  private rememberBridgeOwnedThreadSignal(threadId: string): void {
    const cutoff = Date.now() - CODEX_THREAD_SIGNAL_TTL_MS;
    for (const [candidateThreadId, recordedAtMs] of this.recentBridgeThreadSignalAtById.entries()) {
      if (recordedAtMs < cutoff) {
        this.recentBridgeThreadSignalAtById.delete(candidateThreadId);
      }
    }
    this.recentBridgeThreadSignalAtById.set(threadId, Date.now());
  }

  private isRecentlyBridgeOwnedThread(threadId: string): boolean {
    const recordedAtMs = this.recentBridgeThreadSignalAtById.get(threadId);
    if (!recordedAtMs) {
      return false;
    }
    if (recordedAtMs < Date.now() - CODEX_THREAD_SIGNAL_TTL_MS) {
      this.recentBridgeThreadSignalAtById.delete(threadId);
      return false;
    }
    return true;
  }

  private isBridgeResumeReplay(threadId: string): boolean {
    if (this.bridgeResumeReplayThreadId !== threadId) {
      return false;
    }
    if (Date.now() >= this.bridgeResumeReplayUntilMs) {
      this.clearBridgeResumeReplay();
      return false;
    }
    return true;
  }

  private clearBridgeResumeReplay(): void {
    this.bridgeResumeReplayThreadId = null;
    this.bridgeResumeReplayUntilMs = 0;
  }

  private clearPendingApprovalState(): void {
    this.pendingApprovalRequests = [];
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
  }

  private clearPendingUserInputState(): void {
    if (this.pendingUserInputTimer) {
      clearTimeout(this.pendingUserInputTimer);
      this.pendingUserInputTimer = null;
    }
    this.pendingUserInputRequest = null;
    this.state.pendingUserInput = null;
    this.state.pendingUserInputOrigin = undefined;
  }

  private cleanupTurnArtifacts(turnId: string): void {
    this.clearFinalReplyCompletionTimerForTurn(turnId);
    this.turnFinalMessages.delete(turnId);
    this.turnDeltaByItem.delete(turnId);
    this.turnErrorById.delete(turnId);
    this.turnLastActivityAtMs.delete(turnId);
    this.mirroredUserInputTurnIds.delete(turnId);
    this.bridgeOwnedTurnIds.delete(turnId);
  }

  private rpcRequestKey(requestId: CodexRpcRequestId): string {
    return `${typeof requestId}:${String(requestId)}`;
  }

  private isRpcSocketOpen(): boolean {
    return Boolean(this.rpcSocket && this.rpcSocket.readyState === WebSocket.OPEN);
  }

  private async ensureRpcClientConnected(): Promise<void> {
    if (this.isRpcSocketOpen()) {
      return;
    }

    if (this.rpcReconnectPromise) {
      const reconnected = await this.rpcReconnectPromise;
      if (!reconnected || !this.isRpcSocketOpen()) {
        throw new Error("Codex websocket is not connected.");
      }
      return;
    }

    await this.connectRpcClient();
    if (!this.isRpcSocketOpen()) {
      throw new Error("Codex websocket is not connected.");
    }
  }

  private async sendRpcRequest(method: string, params: unknown): Promise<unknown> {
    await this.ensureRpcClientConnected();
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    const requestId = ++this.rpcRequestCounter;
    const requestKey = this.rpcRequestKey(requestId);
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcRequests.delete(requestKey);
        reject(new Error(`Codex RPC request timed out after 30s (method: ${method})`));
      }, 30_000);
      this.pendingRpcRequests.set(requestKey, {
        method,
        resolve: (value: unknown) => { clearTimeout(timer); resolve(value); },
        reject: (err: unknown) => { clearTimeout(timer); reject(err); },
      });
    });

    try {
      this.sendRpcMessage({
        id: requestId,
        method,
        params,
      });
    } catch (err) {
      this.pendingRpcRequests.delete(requestKey);
      throw err;
    }

    return await responsePromise;
  }

  private sendRpcMessage(payload: Record<string, unknown>): void {
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    socket.send(JSON.stringify(payload));
  }

  private async respondToApprovalRequest(
    request: CodexPendingApprovalRequest,
    action: "confirm" | "deny",
  ): Promise<void> {
    if (request.method === "item/permissions/requestApproval") {
      this.sendRpcMessage({
        id: request.requestId,
        result: buildCodexPermissionsRequestApprovalResponse(request.params, action),
      });
      return;
    }

    const decision = action === "confirm" ? "accept" : "decline";
    this.sendRpcMessage({
      id: request.requestId,
      result: { decision },
    });
  }

  private handleRpcMessageData(data: unknown): void {
    const text = coerceWebSocketMessageData(data);
    if (!text) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!isRecord(payload)) {
      return;
    }

    const requestId = getCodexRpcRequestId(payload.id);
    const method = typeof payload.method === "string" ? payload.method : null;

    if (requestId !== null && method) {
      this.handleRpcServerRequest(requestId, method, payload.params);
      return;
    }

    if (requestId !== null) {
      this.handleRpcResponse(requestId, payload);
      return;
    }

    if (method) {
      this.handleRpcNotification(method, payload.params);
    }
  }

  private handleRpcResponse(requestId: CodexRpcRequestId, payload: Record<string, unknown>): void {
    const requestKey = this.rpcRequestKey(requestId);
    const pending = this.pendingRpcRequests.get(requestKey);
    if (!pending) {
      return;
    }

    this.pendingRpcRequests.delete(requestKey);
    if (payload.error !== undefined && payload.error !== null) {
      pending.reject(new Error(normalizeCodexRpcError(payload.error)));
      return;
    }

    pending.resolve(payload.result);
  }

  private handleRpcNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }

    if (method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }

    if (method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }

    if (
      method === "item/started" ||
      method === "item/agentMessage/delta" ||
      method === "item/completed" ||
      method === "turn/completed" ||
      method === "turn/started" ||
      method === "error" ||
      method === "serverRequest/resolved"
    ) {
      if (this.shouldQueuePendingTurnEvent(params)) {
        this.queuedTurnNotifications.push({ method, params });
        return;
      }

      const trackedTurn = this.identifyTrackedTurn(method, params);
      if (!trackedTurn) {
        return;
      }

      this.handleTrackedTurnNotification(method, params, trackedTurn);
      return;
    }

    if (this.activeTurn) {
      this.state.lastOutputAt = nowIso();
    }
  }

  private shouldQueuePendingTurnEvent(params: Record<string, unknown>): boolean {
    if (!this.pendingTurnStart || this.activeTurn || !this.pendingTurnThreadId) {
      return false;
    }

    return getNotificationThreadId(params) === this.pendingTurnThreadId;
  }

  private identifyTrackedTurn(
    method: string,
    params: Record<string, unknown>,
  ): CodexActiveTurn | null {
    const threadId = getNotificationThreadId(params);
    const turnId = getNotificationTurnId(params);
    if (!threadId || !turnId) {
      return null;
    }
    if (this.hasCompletedTurn(turnId)) {
      return null;
    }

    if (this.bridgeOwnedTurnIds.has(turnId)) {
      return {
        threadId,
        turnId,
        origin: "wechat",
      };
    }

    if (this.activeTurn?.turnId === turnId) {
      return {
        threadId,
        turnId,
        origin: this.activeTurn.origin,
      };
    }

    const localBootstrapUserMessage =
      this.isNativePanelMode() &&
      !this.activeTurn &&
      (method === "item/started" || method === "item/completed") &&
      extractCodexUserMessageText(params.item);
    if (localBootstrapUserMessage) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    if (this.sharedThreadId && threadId === this.sharedThreadId) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    if (method === "turn/started" && !this.activeTurn) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    return null;
  }

  private handleTrackedTurnNotification(
    method: string,
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    this.state.lastOutputAt = nowIso();
    this.recordTurnActivity(trackedTurn.turnId);
    this.handleTrackedTurnStarted(trackedTurn);

    switch (method) {
      case "item/started": {
        this.maybeMirrorLocalUserInput(trackedTurn, params.item);
        return;
      }

      case "item/agentMessage/delta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!itemId || !delta) {
          return;
        }

        const deltaByItem = this.getTurnDeltaMap(trackedTurn.turnId);
        const previous = deltaByItem.get(itemId) ?? "";
        deltaByItem.set(itemId, `${previous}${delta}`);
        return;
      }

      case "item/completed": {
        this.maybeMirrorLocalUserInput(trackedTurn, params.item);
        const itemId =
          isRecord(params.item) && typeof params.item.id === "string"
            ? params.item.id
            : null;
        const finalText = extractCodexFinalTextFromItem(params.item);
        if (itemId && finalText) {
          this.getTurnFinalMessageMap(trackedTurn.turnId).set(itemId, finalText);
          this.scheduleFinalReplyCompletionIfEligible(trackedTurn.turnId);
        }
        return;
      }

      case "error": {
        if (isRecord(params.error) && typeof params.error.message === "string") {
          this.turnErrorById.set(trackedTurn.turnId, params.error.message);
        }
        return;
      }

      case "serverRequest/resolved": {
        const requestId = getCodexRpcRequestId(params.requestId);
        if (
          requestId !== null &&
          this.pendingApprovalRequests.some(
            (r) => r.requestId === requestId && r.turnId === trackedTurn.turnId,
          )
        ) {
          this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
            (r) => r.requestId !== requestId,
          );
          if (this.pendingApprovalRequests.length === 0) {
            this.clearPendingApprovalState();
          }
          if (this.state.status === "awaiting_approval") {
            this.setStatus("busy", "Codex approval resolved.");
          }
        }
        if (
          requestId !== null &&
          this.pendingUserInputRequest &&
          requestId === this.pendingUserInputRequest.requestId &&
          trackedTurn.turnId === this.pendingUserInputRequest.turnId
        ) {
          this.clearPendingUserInputState();
          if (this.state.status === "awaiting_input") {
            this.setStatus("busy", "Codex user input resolved.");
          }
        }
        return;
      }

      case "turn/completed": {
        this.clearFinalReplyCompletionTimerForTurn(trackedTurn.turnId);
        this.handleTurnCompleted(trackedTurn, params);
        return;
      }
    }
  }

  private handleRpcServerRequest(
    requestId: CodexRpcRequestId,
    method: string,
    params: unknown,
  ): void {
    if (method === "currentTime/read") {
      this.sendRpcMessage({
        id: requestId,
        result: {
          currentTimeAt: Math.floor(Date.now() / 1_000),
        },
      });
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      this.sendRpcMessage({
        id: requestId,
        result: buildCodexMcpServerElicitationDeclineResponse(),
      });
      return;
    }

    if (method === "item/tool/call") {
      this.sendRpcMessage({
        id: requestId,
        result: buildCodexDynamicToolCallFailureResponse(),
      });
      return;
    }

    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval" &&
      method !== "item/permissions/requestApproval" &&
      method !== "item/tool/requestUserInput"
    ) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32601,
          message: `Unsupported server request: ${method}`,
        },
      });
      return;
    }

    if (!isRecord(params)) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex approval request payload.",
        },
      });
      return;
    }

    if (this.shouldQueuePendingTurnEvent(params)) {
      this.queuedTurnServerRequests.push({
        requestId,
        method,
        params,
      });
      return;
    }

    const trackedTurn =
      this.identifyTrackedTurn("server/request", params) ??
      this.fallbackTrackedTurnForServerRequest(params);
    if (!trackedTurn) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex server request payload: missing threadId or turnId.",
        },
      });
      return;
    }

    this.handleTrackedTurnStarted(trackedTurn);
    this.handleTrackedTurnServerRequest(requestId, method, params, trackedTurn);
  }

  private handleTrackedTurnServerRequest(
    requestId: CodexRpcRequestId,
    method: CodexPendingApprovalRequest["method"] | CodexPendingUserInputRequest["method"],
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    if (method === "item/tool/requestUserInput") {
      this.handleTrackedTurnUserInputRequest(requestId, params, trackedTurn);
      return;
    }

    const denyMessage = getCodexWechatOutboundAttachmentDenyMessage(method, params);
    if (denyMessage) {
      this.sendRpcMessage({
        id: requestId,
        result:
          method === "item/permissions/requestApproval"
            ? buildCodexPermissionsRequestApprovalResponse(params, "deny")
            : { decision: "decline" },
      });
      this.state.lastOutputAt = nowIso();
      this.setStatus(
        "busy",
        `Codex approval auto-denied: ${truncatePreview(denyMessage, 180)}`,
      );
      return;
    }

    const autoResponse = getCodexApprovalAutoResponse(method, params);
    if (autoResponse) {
      this.sendRpcMessage({
        id: requestId,
        result: autoResponse.result,
      });
      this.state.lastOutputAt = nowIso();
      this.setStatus(
        "busy",
        `Codex approval auto-approved: ${truncatePreview(autoResponse.reason, 180)}`,
      );
      return;
    }

    const request = buildCodexApprovalRequest(method, params);
    if (!request) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex approval request payload.",
        },
      });
      return;
    }

    this.pendingApprovalRequests.push({
      requestId,
      method,
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
      params,
    });
    this.pendingApproval = request;
    this.state.pendingApproval = request;
    this.state.pendingApprovalOrigin = trackedTurn.origin;
    this.state.lastOutputAt = nowIso();
    this.setStatus(
      "awaiting_approval",
      `Codex approval is required: ${truncatePreview(request.commandPreview, 180)}`,
    );
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
    });
  }

  private fallbackTrackedTurnForServerRequest(
    params: Record<string, unknown>,
  ): CodexActiveTurn | null {
    if (this.activeTurn) {
      return null;
    }

    const threadId = getNotificationThreadId(params);
    const turnId = getNotificationTurnId(params);
    if (!threadId || !turnId) {
      return null;
    }

    return {
      threadId,
      turnId,
      origin: this.bridgeOwnedTurnIds.has(turnId) ? "wechat" : "local",
    };
  }

  private handleTrackedTurnUserInputRequest(
    requestId: CodexRpcRequestId,
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    const request = buildCodexUserInputRequest(params);
    if (!request) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex user input request payload.",
        },
      });
      return;
    }

    this.pendingUserInputRequest = {
      requestId,
      method: "item/tool/requestUserInput",
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
      isBlocking: params.isBlocking !== false,
    };
    this.state.pendingUserInput = request;
    this.state.pendingUserInputOrigin = trackedTurn.origin;
    this.state.lastOutputAt = nowIso();
    this.setStatus("awaiting_input", "Codex is waiting for user input.");
    this.emit({
      type: "user_input_required",
      request,
      timestamp: nowIso(),
    });

    if (this.pendingUserInputRequest.isBlocking) {
      return;
    }

    const pendingRequest = this.pendingUserInputRequest;
    this.pendingUserInputTimer = setTimeout(() => {
      if (this.pendingUserInputRequest !== pendingRequest) {
        return;
      }
      this.sendRpcMessage({
        id: pendingRequest.requestId,
        result: {
          answers: {},
        },
      });
      this.clearPendingUserInputState();
      if (this.state.status === "awaiting_input") {
        this.setStatus("busy", "Codex non-blocking user input timed out.");
      }
    }, this.userInputAutoResolutionDelayMs);
    this.pendingUserInputTimer.unref?.();
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const threadId = extractCodexThreadFollowIdFromStatusChanged(params);
    if (!threadId) {
      return;
    }
    if (this.pendingVisibleResume) {
      return;
    }
    if (this.isBridgeResumeReplay(threadId)) {
      return;
    }

    const notificationCwd =
      typeof params.cwd === "string"
        ? params.cwd
        : isRecord(params.thread) && typeof params.thread.cwd === "string"
          ? params.thread.cwd
          : null;
    if (
      notificationCwd &&
      normalizeComparablePath(notificationCwd) !== normalizeComparablePath(this.options.cwd)
    ) {
      return;
    }

    if (!this.isTrustedThreadStatus(threadId, Boolean(notificationCwd))) {
      this.queueThreadStatusCwdCheck(threadId);
      return;
    }

    this.applyThreadStatusChanged(threadId);
  }

  private isTrustedThreadStatus(threadId: string, hasCwd: boolean): boolean {
    if (hasCwd || this.isNativePanelMode()) {
      return true;
    }
    return (
      this.subscribedThreadIds.has(threadId) ||
      this.activeTurn?.threadId === threadId ||
      this.pendingTurnThreadId === threadId ||
      this.pendingVisibleResume?.targetThreadId === threadId
    );
  }

  private queueThreadStatusCwdCheck(threadId: string): void {
    if (this.pendingThreadStatusChecks.has(threadId)) {
      return;
    }

    const epoch = this.threadStatusCheckEpoch;
    const check = this.sendRpcRequest("thread/read", {
      threadId,
      includeTurns: false,
    })
      .then((response) => {
        if (epoch !== this.threadStatusCheckEpoch) {
          return;
        }
        if (!isRecord(response) || !isRecord(response.thread)) {
          return;
        }
        const thread = response.thread;
        if (
          thread.id === threadId &&
          typeof thread.cwd === "string" &&
          normalizeComparablePath(thread.cwd) === normalizeComparablePath(this.options.cwd) &&
          typeof thread.parentThreadId !== "string" &&
          thread.ephemeral !== true
        ) {
          this.applyThreadStatusChanged(threadId);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingThreadStatusChecks.delete(threadId);
      });
    this.pendingThreadStatusChecks.set(threadId, check);
  }

  private applyThreadStatusChanged(threadId: string): void {

    if (
      !this.activeTurn ||
      this.activeTurn.threadId === threadId ||
      this.activeTurn.origin === "wechat"
    ) {
      this.trackLocalSharedThread(threadId, {
        reason: "local_follow",
        signal: "status_changed",
      });
      this.pendingThreadFollowId = null;
      return;
    }

    this.pendingThreadFollowId = threadId;
  }

  private handleThreadStarted(params: Record<string, unknown>): void {
    const threadId = extractCodexThreadStartedThreadId(params);
    if (!threadId) {
      return;
    }
    if (this.isBridgeResumeReplay(threadId)) {
      return;
    }

    if (this.isRecentlyBridgeOwnedThread(threadId)) {
      return;
    }

    const thread = isRecord(params.thread) ? params.thread : null;
    if (thread) {
      if (
        (typeof thread.cwd === "string" &&
          normalizeComparablePath(thread.cwd) !== normalizeComparablePath(this.options.cwd)) ||
        typeof thread.parentThreadId === "string" ||
        thread.ephemeral === true
      ) {
        return;
      }
    }

    if (
      !this.activeTurn ||
      this.activeTurn.threadId === threadId ||
      this.activeTurn.origin === "wechat"
    ) {
      this.trackLocalSharedThread(threadId, {
        reason: "local_follow",
        signal: "thread_started",
      });
      this.pendingThreadFollowId = null;
      return;
    }

    this.pendingThreadFollowId = threadId;
  }

  private handleTrackedTurnStarted(trackedTurn: CodexActiveTurn): void {
    if (this.activeTurn?.turnId === trackedTurn.turnId) {
      return;
    }
    if (trackedTurn.origin === "local") {
      this.clearBridgeResumeReplay();
    }

    if (
      trackedTurn.origin === "local" &&
      trackedTurn.threadId !== this.sharedThreadId
    ) {
      if (
        !this.activeTurn ||
        this.activeTurn.threadId === trackedTurn.threadId ||
        this.activeTurn.origin === "wechat"
      ) {
        this.trackLocalSharedThread(trackedTurn.threadId, {
          reason: "local_turn",
          signal: "turn_started",
        });
        this.pendingThreadFollowId = null;
      } else {
        this.pendingThreadFollowId = trackedTurn.threadId;
      }
    }

    if (!this.activeTurn) {
      this.setActiveTurn(trackedTurn);
      if (trackedTurn.origin === "local" && this.state.status !== "awaiting_approval") {
        this.setStatus("busy", "Codex is busy with a local terminal turn.");
      }
      return;
    }

    if (this.activeTurn.threadId !== trackedTurn.threadId) {
      this.pendingThreadFollowId = trackedTurn.threadId;
    }
  }

  private maybeMirrorLocalUserInput(
    trackedTurn: CodexActiveTurn,
    item: unknown,
  ): void {
    if (trackedTurn.origin !== "local" || this.mirroredUserInputTurnIds.has(trackedTurn.turnId)) {
      return;
    }

    const text = extractCodexUserMessageText(item);
    if (!text) {
      return;
    }

    this.trackLocalSharedThread(trackedTurn.threadId, {
      reason: "local_turn",
      signal: "user_message",
    });
    this.mirroredUserInputTurnIds.add(trackedTurn.turnId);
    this.emit({
      type: "mirrored_user_input",
      text,
      timestamp: nowIso(),
      origin: "local",
    });
  }

  private handleTurnCompleted(
    trackedTurn: CodexActiveTurn,
    params: Record<string, unknown>,
  ): void {
    this.clearFinalReplyCompletionTimerForTurn(trackedTurn.turnId);
    if (this.hasCompletedTurn(trackedTurn.turnId)) {
      if (this.activeTurn?.turnId === trackedTurn.turnId) {
        this.setActiveTurn(null);
      }
      this.cleanupTurnArtifacts(trackedTurn.turnId);
      return;
    }

    const turn = isRecord(params.turn) ? params.turn : null;
    const status = turn && typeof turn.status === "string" ? turn.status : "completed";
    const completedError =
      turn && isRecord(turn.error) && typeof turn.error.message === "string"
        ? turn.error.message
        : this.turnErrorById.get(trackedTurn.turnId) ?? null;
    const finalText = this.collectTurnOutput(trackedTurn.turnId);
    const completedTrackedTurn =
      this.activeTurn?.turnId === trackedTurn.turnId ? this.activeTurn : trackedTurn;
    const summary =
      status === "interrupted"
        ? "Interrupted"
        : completedTrackedTurn.origin === "local"
          ? "Local terminal turn completed."
          : this.currentPreview;

    if (
      this.pendingApprovalRequests.length > 0 &&
      this.pendingApprovalRequests.some((r) => r.turnId === trackedTurn.turnId)
    ) {
      this.clearPendingApprovalState();
    }
    if (
      this.pendingUserInputRequest &&
      this.pendingUserInputRequest.turnId === trackedTurn.turnId
    ) {
      this.clearPendingUserInputState();
    }
    if (this.activeTurn?.turnId === trackedTurn.turnId) {
      this.setActiveTurn(null);
    }
    if (completedTrackedTurn.origin === "wechat") {
      this.blockLateLocalThreadFollow();
    }
    this.cleanupTurnArtifacts(trackedTurn.turnId);

    if (
      this.state.status !== "stopped" &&
      (!this.activeTurn || this.activeTurn.turnId === trackedTurn.turnId)
    ) {
      const statusMessage =
        status === "interrupted" ? "Codex task interrupted." : undefined;
      this.setStatus("idle", statusMessage);
    }

    if (finalText) {
      this.emit({
        type: "final_reply",
        text: finalText,
        timestamp: nowIso(),
      });
    } else if (status === "failed") {
      const failureText = completedError
        ? `Codex could not complete the request: ${completedError}`
        : "Codex could not complete the request.";
      this.emit({
        type: "stdout",
        text: failureText,
        timestamp: nowIso(),
      });
    }
    this.emit({
      type: "task_complete",
      summary,
      timestamp: nowIso(),
    });
    this.rememberCompletedTurn(trackedTurn.turnId);
  }

  private getTurnFinalMessageMap(turnId: string): Map<string, string> {
    let finalMessages = this.turnFinalMessages.get(turnId);
    if (!finalMessages) {
      finalMessages = new Map<string, string>();
      this.turnFinalMessages.set(turnId, finalMessages);
    }
    return finalMessages;
  }

  private getTurnDeltaMap(turnId: string): Map<string, string> {
    let deltaByItem = this.turnDeltaByItem.get(turnId);
    if (!deltaByItem) {
      deltaByItem = new Map<string, string>();
      this.turnDeltaByItem.set(turnId, deltaByItem);
    }
    return deltaByItem;
  }

  private collectTurnOutput(turnId: string): string | null {
    const finalMessages = Array.from(this.getTurnFinalMessageMap(turnId).values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (finalMessages.length > 0) {
      return finalMessages.join("\n\n");
    }

    const deltaFallback = Array.from(this.getTurnDeltaMap(turnId).values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (deltaFallback.length === 0) {
      return null;
    }

    return deltaFallback[deltaFallback.length - 1] ?? null;
  }

  private recordTurnActivity(turnId: string, timestamp: string | number = Date.now()): void {
    const timestampMs =
      typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    this.turnLastActivityAtMs.set(
      turnId,
      Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    );
  }

  private clearFinalReplyCompletionTimer(): void {
    if (this.finalReplyCompletionTimer) {
      clearTimeout(this.finalReplyCompletionTimer);
      this.finalReplyCompletionTimer = null;
    }
    this.finalReplyCompletionTurnId = null;
  }

  private clearFinalReplyCompletionTimerForTurn(turnId: string): void {
    if (this.finalReplyCompletionTurnId !== turnId) {
      return;
    }
    this.clearFinalReplyCompletionTimer();
  }

  private scheduleFinalReplyCompletionIfEligible(turnId: string): void {
    if (
      !this.activeTurn ||
      this.activeTurn.turnId !== turnId ||
      this.activeTurn.origin !== "wechat" ||
      this.pendingTurnStart ||
      this.pendingApproval ||
      this.pendingApprovalRequests.length ||
      this.pendingUserInputRequest ||
      this.state.pendingUserInput ||
      !this.collectTurnOutput(turnId)
    ) {
      return;
    }

    this.clearFinalReplyCompletionTimer();
    this.finalReplyCompletionTurnId = turnId;
    this.finalReplyCompletionTimer = setTimeout(() => {
      this.autoCompleteWechatTurnAfterFinalReply(turnId);
    }, CODEX_FINAL_REPLY_SETTLE_DELAY_MS);
    this.finalReplyCompletionTimer.unref?.();
  }

  private autoCompleteWechatTurnAfterFinalReply(turnId: string): void {
    this.clearFinalReplyCompletionTimerForTurn(turnId);

    const activeTurn = this.activeTurn;
    const finalText = this.collectTurnOutput(turnId);
    const lastActivityAtMs = this.turnLastActivityAtMs.get(turnId) ?? null;
    const pendingApproval = Boolean(this.pendingApproval || this.pendingApprovalRequests.length);
    const pendingUserInput = Boolean(this.pendingUserInputRequest || this.state.pendingUserInput);
    const nowMs = Date.now();
    if (
      !shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: turnId,
        activeTurnId: activeTurn?.turnId,
        activeTurnOrigin: activeTurn?.origin,
        pendingTurnStart: this.pendingTurnStart,
        hasPendingApproval: pendingApproval,
        hasPendingUserInput: pendingUserInput,
        hasFinalOutput: Boolean(finalText),
        hasCompletedTurn: this.hasCompletedTurn(turnId),
        lastActivityAtMs,
        nowMs,
        settleDelayMs: CODEX_FINAL_REPLY_SETTLE_DELAY_MS,
      })
    ) {
      if (
        activeTurn?.turnId === turnId &&
        activeTurn.origin === "wechat" &&
        !this.pendingTurnStart &&
        !pendingApproval &&
        !pendingUserInput &&
        finalText &&
        typeof lastActivityAtMs === "number"
      ) {
        const remainingMs = CODEX_FINAL_REPLY_SETTLE_DELAY_MS - (nowMs - lastActivityAtMs);
        if (remainingMs > 0) {
          this.finalReplyCompletionTurnId = turnId;
          this.finalReplyCompletionTimer = setTimeout(() => {
            this.autoCompleteWechatTurnAfterFinalReply(turnId);
          }, remainingMs);
          this.finalReplyCompletionTimer.unref?.();
        }
      }
      return;
    }

    if (!activeTurn || !finalText) {
      return;
    }

    if (activeTurn.origin === "wechat") {
      this.blockLateLocalThreadFollow();
    }
    this.clearPendingApprovalState();
    this.clearPendingUserInputState();
    this.setActiveTurn(null);
    this.cleanupTurnArtifacts(turnId);
    this.state.lastOutputAt = nowIso();
    if (this.state.status !== "stopped") {
      this.setStatus("idle", "Recovered delayed Codex completion after final reply.");
    }
    this.emit({
      type: "final_reply",
      text: finalText,
      timestamp: nowIso(),
    });
    this.emit({
      type: "task_complete",
      summary: this.currentPreview,
      timestamp: nowIso(),
    });
    this.rememberCompletedTurn(turnId);
  }

  private async stopAppServer(): Promise<void> {
    if (!this.appServer) {
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      this.deleteAppServerAuthTokenFile();
      this.appServerAuthToken = null;
      return;
    }

    const child = this.appServer;
    this.appServerShuttingDown = true;
    this.appServer = null;
    this.appServerPort = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        if (child.pid) {
          killProcessTreeSync(child.pid);
        } else {
          child.kill();
        }
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();
    });

    this.deleteAppServerAuthTokenFile();
    this.appServerAuthToken = null;
  }

  private describeAppServerLog(): string {
    const normalized = normalizeOutput(this.appServerLog).trim();
    if (!normalized) {
      return "";
    }
    const summary = summarizeOutput(normalized, 500);
    return ` Recent app-server log: ${summary}`;
  }

  private terminateCodexClient(): void {
    this.shuttingDown = true;

    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Best effort cleanup after embedded client failure.
      }
      return;
    }

    if (this.nativeProcess) {
      try {
        if (this.nativeProcess.pid) {
          killProcessTreeSync(this.nativeProcess.pid);
        } else {
          this.nativeProcess.kill();
        }
      } catch {
        // Best effort cleanup after panel client failure.
      }
    }
  }

  private deleteAppServerAuthTokenFile(): void {
    if (!this.appServerAuthTokenFilePath) {
      return;
    }

    try {
      fs.unlinkSync(this.appServerAuthTokenFilePath);
    } catch {
      // Best effort cleanup after app-server shutdown.
    }

    this.appServerAuthTokenFilePath = null;
  }

  private attachLocalInputForwarding(): void {
    if (this.localInputListener || !process.stdin.readable) {
      return;
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    this.localInputListener = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localInputListener);
  }

  private detachLocalInputForwarding(): void {
    if (!this.localInputListener) {
      return;
    }

    process.stdin.off("data", this.localInputListener);
    this.localInputListener = null;
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Codex panel.
    }
  }

  private hasCompletedTurn(turnId: string): boolean {
    return this.completedTurnIds.has(turnId);
  }

  private rememberCompletedTurn(turnId: string): void {
    if (this.completedTurnIds.has(turnId)) {
      return;
    }

    this.completedTurnIds.add(turnId);
    this.completedTurnOrder.push(turnId);
    while (this.completedTurnOrder.length > CODEX_RECENT_SESSION_KEY_LIMIT) {
      const staleTurnId = this.completedTurnOrder.shift();
      if (staleTurnId) {
        this.completedTurnIds.delete(staleTurnId);
      }
    }
  }
}

export function shouldTreatCodexNativeExitAsExpected(params: {
  renderMode?: AdapterOptions["renderMode"];
  shuttingDown: boolean;
  exitCode: number | undefined;
  signal?: NodeJS.Signals;
  startupError?: Error;
}): boolean {
  return (
    params.shuttingDown ||
    (params.renderMode === "panel" &&
      !params.startupError &&
      !params.signal &&
      params.exitCode === 0)
  );
}

export function shouldSuppressCodexTransportFatalError(params: {
  transportShuttingDown: boolean;
  shuttingDown: boolean;
  cleanPanelExitInProgress: boolean;
}): boolean {
  return (
    params.transportShuttingDown ||
    params.shuttingDown ||
    params.cleanPanelExitInProgress
  );
}

