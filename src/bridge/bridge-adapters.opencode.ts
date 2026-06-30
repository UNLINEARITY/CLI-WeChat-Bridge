import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";

import {
  type AdapterOptions,
  type EventSink,
  OPENCODE_SERVER_HOST,
  OPENCODE_SERVER_READY_TIMEOUT_MS,
  OPENCODE_SSE_RECONNECT_DELAY_MS,
  OPENCODE_SESSION_IDLE_SETTLE_MS,
  OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS,
  buildCliEnvironment,
  isRecord,
  describeUnknownError,
  resolveSpawnTarget,
  reserveLocalPort,
  waitForTcpPort,
  delay,
} from "./bridge-adapters.shared.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeResumeSessionCandidate,
  BridgeTurnOrigin,
  BridgeEvent,
  PendingApproval,
} from "./bridge-types.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import {
  WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE,
  buildOneTimeCode,
  isWechatOutboundAttachmentMutationTool,
  isWechatOutboundAttachmentWriteCommand,
  normalizeOutput,
  nowIso,
  truncatePreview,
  OutputBatcher,
} from "./bridge-utils.ts";

/* ------------------------------------------------------------------ */
/*  Types for @opencode-ai/sdk (loose to avoid hard import-time deps) */
/* ------------------------------------------------------------------ */

/**
 * The real @opencode-ai/sdk OpencodeClient uses hey-api generated methods
 * that return { data, error, request, response }.  We define a minimal
 * interface so the adapter can call methods without importing the SDK at
 * compile-time (the SDK is loaded dynamically via createSdkClient).
 */
type SdkResult<T> =
  | { data: T; error: undefined; request: unknown; response: unknown }
  | { data: undefined; error: unknown; request: unknown; response: unknown };

type SdkSession = {
  id: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
  share?: { url: string };
};

type SdkPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
} & Record<string, unknown>;

type SdkMessageRecord = {
  info: Record<string, unknown>;
  parts: SdkPart[];
};

type OpenCodeSdkClient = {
  session: {
    list(parameters?: Record<string, unknown>): Promise<SdkResult<SdkSession[]>>;
    create(parameters?: Record<string, unknown>): Promise<SdkResult<SdkSession>>;
    get(parameters: {
      sessionID: string;
      directory?: string;
      workspace?: string;
    }): Promise<SdkResult<SdkSession>>;
    abort(parameters: {
      sessionID: string;
      directory?: string;
      workspace?: string;
    }): Promise<SdkResult<unknown>>;
    promptAsync(parameters: {
      sessionID: string;
      directory?: string;
      workspace?: string;
      parts: Array<{ type: string; text: string }>;
    }): Promise<SdkResult<void>>;
    messages?(parameters: {
      sessionID: string;
      directory?: string;
      workspace?: string;
      limit?: number;
    }): Promise<SdkResult<SdkMessageRecord[]>>;
  };
  permission: {
    respond(parameters: {
      sessionID: string;
      permissionID: string;
      directory?: string;
      workspace?: string;
      response: string;
    }): Promise<SdkResult<boolean>>;
  };
  tui: {
    selectSession(parameters?: {
      directory?: string;
      workspace?: string;
      sessionID?: string;
    }): Promise<SdkResult<boolean>>;
  };
  event: {
    subscribe(
      parameters?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<{
      stream: AsyncIterable<unknown>;
    }>;
  };
  global: {
    event(options?: Record<string, unknown>): Promise<{
      stream: AsyncIterable<unknown>;
    }>;
    syncEvent: {
      subscribe(options?: Record<string, unknown>): Promise<{
        stream: AsyncIterable<unknown>;
      }>;
    };
  };
};

type SdkEvent = {
  type: string;
  properties?: unknown;
  data?: unknown;
  payload?: unknown;
};

type SdkEventStreamName = "event" | "global-event" | "global-sync";

type SdkEventSubscription = {
  stream: AsyncIterable<unknown>;
};

type NormalizedSdkEvent = {
  type: string;
  properties?: unknown;
  data?: unknown;
  directory?: string;
};

type OpenCodePendingPermission = {
  sessionId: string;
  permissionId: string;
  code: string;
  createdAt: string;
  request: ApprovalRequest;
};

type ObservedOpenCodeMessage = {
  sessionId: string;
  role?: "user" | "assistant";
  text: string;
  emitted: boolean;
  updatedAtMs: number;
};

type VisibleReplyPart = {
  sessionId: string;
  messageId?: string;
  text: string;
};

type PendingWechatPromptMirrorSuppression = {
  sessionId: string;
  text: string;
  createdAtMs: number;
};

const OPENCODE_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.WECHAT_OPENCODE_DEBUG ?? "",
);
const OPENCODE_DUPLICATE_EVENT_TTL_MS = 150;
const OPENCODE_WECHAT_MIRROR_SUPPRESSION_TTL_MS = 30_000;
const OPENCODE_RECENT_LOCAL_PROMPT_TTL_MS = 10_000;
const OPENCODE_LOCAL_SESSION_CREATE_FOLLOW_TTL_MS = 5_000;
const OPENCODE_TUI_SELECT_RETRY_DELAYS_MS = [250, 750, 1_500] as const;

/* ------------------------------------------------------------------ */
/*  Adapter                                                            */
/* ------------------------------------------------------------------ */

export class OpenCodeServerAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;

  private serverProcess: ChildProcess | null = null;
  private nativeProcess: ChildProcess | null = null;
  private serverPort = 0;
  private client: OpenCodeSdkClient | null = null;
  private sseAbortController: AbortController | null = null;
  private sseLoopPromise: Promise<void> | null = null;
  private activeSessionId: string | null = null;
  private activeWorkspaceId: string | null = null;
  private outputBatcher: OutputBatcher;
  private shuttingDown = false;
  private hasAcceptedInput = false;
  private currentPreview = "(idle)";
  private workingNoticeDelayMs: number;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private lastBusyAtMs = 0;
  // Monotonic token bumped on every beginTrackedTurn. Lets a deferred turn
  // completion (.then in handleSessionIdle) detect that a newer turn started
  // while it was awaiting, so the stale completion becomes a no-op instead of
  // clobbering the in-flight turn (stale final_reply / status flip / batcher clear).
  private currentTurnToken = 0;
  private pendingLocalPrompt = "";
  private localPromptNoticeSent = false;
  private readonly loggedUnknownEventTypes = new Set<string>();
  private readonly emittedTextByPartId = new Map<string, string>();
  private readonly partTypeByPartId = new Map<string, string>();
  private readonly visibleReplyPartsByPartId = new Map<string, VisibleReplyPart>();
  private readonly visibleReplyMessageIds = new Set<string>();
  private readonly observedOpenCodeMessages = new Map<string, ObservedOpenCodeMessage>();
  private readonly observedUserTextByPartId = new Map<string, string>();
  private readonly observedUserMessagePartIds = new Map<string, Set<string>>();
  private readonly pendingWechatPromptMirrorSuppressions: PendingWechatPromptMirrorSuppression[] = [];
  private readonly recentWechatPromptMirrorSuppressions: PendingWechatPromptMirrorSuppression[] = [];
  private readonly recentSdkEventObservations = new Map<
    string,
    { streamName: SdkEventStreamName; observedAtMs: number }
  >();
  private suppressedTuiSessionSelectId: string | null = null;
  private lastMirroredLocalPrompt: { text: string; createdAtMs: number } | null = null;
  private pendingLocalSessionCreateFollowUntilMs = 0;

  private pendingPermission: OpenCodePendingPermission | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
    this.outputBatcher = new OutputBatcher((text) =>
      this.flushOutputBatch(text),
    );
    this.workingNoticeDelayMs = OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS;
  }

  /* ---- BridgeAdapter interface ---- */

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  async start(): Promise<void> {
    if (this.serverProcess || this.nativeProcess) {
      return;
    }

    this.shuttingDown = false;
    this.setStatus("starting", "Starting OpenCode companion...");

    try {
      this.serverPort = await reserveLocalPort();
      const serverProcess = await this.startServerProcess();

      await waitForTcpPort(
        OPENCODE_SERVER_HOST,
        this.serverPort,
        OPENCODE_SERVER_READY_TIMEOUT_MS,
      );

      await this.createSdkClient();
      await this.checkHealth();
      await this.initializeSessions();
      this.startSseListener();
      if (this.options.renderMode === "companion") {
        await this.startNativeClient();
        await this.syncVisibleSessionToShared({ force: true, retry: true });
      } else {
        this.state.pid = serverProcess.pid;
        this.state.startedAt = nowIso();
      }

      this.setStatus("idle", "OpenCode adapter is ready.");
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start OpenCode: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      await this.dispose();
      throw err;
    }
  }

  async sendInput(text: string): Promise<void> {
    if (!this.client) {
      throw new Error("OpenCode adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("OpenCode is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingPermission) {
      throw new Error("An OpenCode approval request is pending. Reply with /confirm or /deny.");
    }

    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    this.outputBatcher.clear();
    this.clearStreamedPartState();

    const session = await this.ensureSession();
    this.switchSharedSession(session, {
      source: "wechat",
      reason: "wechat_resume",
      syncVisible: true,
      forceVisibleSync: true,
    });
    this.recordPendingWechatPromptMirrorSuppression(session.id, normalized);
    this.beginTrackedTurn(normalized, "wechat");

    try {
      const result = await this.client.session.promptAsync({
        sessionID: session.id,
        directory: this.options.cwd,
        workspace: session.workspaceID ?? this.activeWorkspaceId ?? undefined,
        parts: [{ type: "text", text: normalized }],
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      this.settleTurnState();
      this.clearObservedMessageTracking();
      this.setStatus("idle");
      throw new Error(`Failed to send prompt: ${describeUnknownError(err)}`, {
        cause: err,
      });
    }
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    void limit;
    throw new Error(
      'WeChat /resume is disabled in opencode mode. Use /session directly inside "wechat-opencode"; WeChat will follow the active local session.',
    );
  }

  async resumeSession(sessionId: string): Promise<void> {
    void sessionId;
    throw new Error(
      'WeChat /resume is disabled in opencode mode. Use /session directly inside "wechat-opencode"; WeChat will follow the active local session.',
    );
  }

  async createSession(): Promise<void> {
    if (!this.client) {
      throw new Error("OpenCode adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("OpenCode is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingPermission) {
      throw new Error("An OpenCode approval request is pending. Reply with /confirm or /deny.");
    }

    this.outputBatcher.clear();
    this.clearStreamedPartState();

    const session = this.unwrapOrThrow(
      await this.client.session.create({
        directory: this.options.cwd,
        workspace: this.activeWorkspaceId ?? undefined,
      }),
    );
    this.switchSharedSession(session, {
      source: "wechat",
      reason: "wechat_resume",
      notify: true,
      clearTrackedTurn: true,
      syncVisible: true,
      forceVisibleSync: true,
      retryVisibleSync: true,
    });
  }

  async interrupt(): Promise<boolean> {
    if (!this.client || !this.activeSessionId) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearWechatWorkingNotice(true);

    try {
      await this.client.session.abort({
        sessionID: this.activeSessionId,
        directory: this.options.cwd,
        workspace: this.activeWorkspaceId ?? undefined,
      });
    } catch {
      // Best effort abort.
    }

    return true;
  }

  async reset(): Promise<void> {
    this.clearWechatWorkingNotice(true);
    this.pendingLocalPrompt = "";
    this.localPromptNoticeSent = false;
    this.pendingLocalSessionCreateFollowUntilMs = 0;
    this.clearObservedMessageTracking();
    this.recentSdkEventObservations.clear();
    this.clearPendingPermissionState();
    this.activeSessionId = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    this.hasAcceptedInput = false;
    this.currentPreview = "(idle)";
    this.outputBatcher.clear();
    this.clearStreamedPartState();
    await this.dispose();
    await this.start();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingPermission || !this.client) {
      return false;
    }

    const { sessionId, permissionId } = this.pendingPermission;
    const response = action === "confirm" ? "once" : "reject";

    try {
      const result = await this.client.permission.respond({
        sessionID: sessionId,
        permissionID: permissionId,
        directory: this.options.cwd,
        workspace: this.activeWorkspaceId ?? undefined,
        response,
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      this.emit({
        type: "stderr",
        text: `Failed to resolve permission: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      return false;
    }

    this.clearWechatWorkingNotice();
    this.clearPendingPermissionState();
    this.setStatus("busy");
    return true;
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    const ok = await this.resolveApproval(action);
    return ok ? 1 : 0;
  }

  async submitUserInput(_answers: Record<string, string[]>): Promise<boolean> {
    return false;
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.clearWechatWorkingNotice(true);
    this.pendingLocalPrompt = "";
    this.localPromptNoticeSent = false;
    this.pendingLocalSessionCreateFollowUntilMs = 0;
    this.clearObservedMessageTracking();
    this.recentSdkEventObservations.clear();
    this.outputBatcher.clear();
    this.clearStreamedPartState();

    this.clearPendingPermissionState();

    // Stop SSE listener
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    if (this.sseLoopPromise) {
      try {
        await Promise.race([this.sseLoopPromise, delay(3_000)]);
      } catch {
        // Ignore SSE loop errors during shutdown.
      }
      this.sseLoopPromise = null;
    }

    if (this.nativeProcess) {
      const proc = this.nativeProcess;
      this.nativeProcess = null;
      if (proc.pid != null) {
        try {
          killProcessTreeSync(proc.pid);
        } catch {
          // Best effort.
        }
      }
    }

    if (this.serverProcess) {
      const proc = this.serverProcess;
      this.serverProcess = null;
      if (proc.pid != null) {
        try {
          killProcessTreeSync(proc.pid);
        } catch {
          // Best effort.
        }
      }
    }

    this.client = null;
    this.activeSessionId = null;
    this.activeWorkspaceId = null;
    this.suppressedTuiSessionSelectId = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.state.startedAt = undefined;
  }

  /* ---- Server management ---- */

  private async startServerProcess(): Promise<ChildProcess> {
    const env = buildCliEnvironment(this.options.kind);
    const serverArgs = [
      "serve",
      "--port",
      String(this.serverPort),
      "--hostname",
      OPENCODE_SERVER_HOST,
    ];

    const target = resolveSpawnTarget(this.options.command, this.options.kind, { env });
    this.serverProcess = spawnChildProcess(target.file, [...target.args, ...serverArgs], {
      cwd: this.options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const server = this.serverProcess;

    server.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logDebug(`[opencode-serve:out] ${text}`);
      }
    });

    server.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logDebug(`[opencode-serve:err] ${text}`);
      }
    });

    server.once("exit", (code) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `OpenCode server exited unexpectedly (code ${code ?? "unknown"}).`,
        timestamp: nowIso(),
      });
      this.setStatus("stopped");
    });

    server.once("error", (err) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `OpenCode server error: ${err.message}`,
        timestamp: nowIso(),
      });
    });

    return server;
  }

  private async startNativeClient(): Promise<void> {
    if (this.nativeProcess) {
      return;
    }

    const env = this.buildNativeClientEnv();
    const attachArgs = await this.buildNativeAttachArgs();
    const target = resolveSpawnTarget(this.options.command, this.options.kind, { env });
    const startedAt = nowIso();
    const child = spawnChildProcess(target.file, [...target.args, ...attachArgs], {
      cwd: this.options.cwd,
      env,
      stdio: "inherit",
      windowsHide: false,
    });

    this.nativeProcess = child;
    this.state.pid = child.pid ?? process.pid;
    this.state.startedAt = startedAt;

    child.once("error", (err) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `Failed to start OpenCode companion: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      this.setStatus("error", "OpenCode companion failed to start.");
    });

    child.once("exit", (code, signal) => {
      if (this.nativeProcess === child) {
        this.nativeProcess = null;
      }
      if (this.shuttingDown) {
        return;
      }

      this.state.pid = undefined;
      this.setStatus("stopped", "OpenCode companion exited.");
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.emit({
        type: "shutdown_requested",
        reason: "companion_closed",
        message: `OpenCode companion exited (${detail}).`,
        exitCode: typeof code === "number" ? code : 0,
        timestamp: nowIso(),
      });
    });
  }

  private async buildNativeAttachArgs(): Promise<string[]> {
    const args = ["attach", this.getServerUrl()];
    args.push("--dir", this.options.cwd);
    const sessionId = this.activeSessionId;
    if (sessionId && (await this.hasSession(sessionId))) {
      args.push("--session", sessionId);
    }
    args.push(...(this.options.extraCliArgs ?? []));
    return args;
  }

  private buildNativeClientEnv(): Record<string, string> {
    const env = buildCliEnvironment(this.options.kind);
    if (this.activeSessionId) {
      env.OPENCODE_ROUTE = JSON.stringify({
        type: "session",
        sessionID: this.activeSessionId,
      });
    }
    return env;
  }

  private async createSdkClient(): Promise<void> {
    try {
      const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
      this.client = createOpencodeClient({
        baseUrl: `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`,
        directory: this.options.cwd,
        experimental_workspaceID: this.activeWorkspaceId ?? undefined,
      }) as unknown as OpenCodeSdkClient;
    } catch (err) {
      throw new Error(
        `Failed to load @opencode-ai/sdk. Make sure it is installed: ${describeUnknownError(err)}`,
        { cause: err },
      );
    }
  }

  private async checkHealth(): Promise<void> {
    const baseUrl = `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
    const response = await fetch(`${baseUrl}/session/status`);
    if (!response.ok) {
      throw new Error(`OpenCode health check failed (HTTP ${response.status}).`);
    }
  }

  private async initializeSessions(): Promise<void> {
    if (!this.client) {
      return;
    }

    if (this.options.sessionStartMode === "new") {
      const session = this.unwrapOrThrow(
        await this.client.session.create({
          directory: this.options.cwd,
          workspace: this.activeWorkspaceId ?? undefined,
        }),
      );
      this.switchSharedSession(session, {
        source: "local",
        reason: "local_follow",
        syncVisible: false,
      });
      this.state.lastSessionSwitchAt = undefined;
      this.state.lastSessionSwitchSource = undefined;
      this.state.lastSessionSwitchReason = undefined;
      return;
    }

    let listedSessions: SdkSession[] = [];

    try {
      const result = await this.client.session.list();
      if (result.data && result.data.length > 0) {
        listedSessions = result.data.filter((session) => this.isCurrentDirectorySession(session));
        const latest = listedSessions[0];
        if (latest) {
          this.switchSharedSession(latest, {
            source: "restore",
            reason: "startup_restore",
            syncVisible: false,
          });
          this.state.lastSessionSwitchAt = undefined;
          this.state.lastSessionSwitchSource = undefined;
          this.state.lastSessionSwitchReason = undefined;
        }
      }
    } catch {
      // Session listing is optional at startup.
    }

    if (this.options.initialSharedSessionId) {
      const restoredSessionId = this.options.initialSharedSessionId;
      const restoredSession = await this.getSessionForCurrentDirectory(restoredSessionId, listedSessions);
      if (!restoredSession) {
        return;
      }

      this.switchSharedSession(restoredSession, {
        source: "restore",
        reason: "startup_restore",
        syncVisible: false,
      });
    }
  }

  private async hasSession(
    sessionId: string,
    listedSessions: SdkSession[] = [],
  ): Promise<boolean> {
    return Boolean(await this.getSessionForCurrentDirectory(sessionId, listedSessions));
  }

  private async getSessionForCurrentDirectory(
    sessionId: string,
    listedSessions: SdkSession[] = [],
  ): Promise<SdkSession | null> {
    if (!this.client) {
      return null;
    }

    const listedSession = listedSessions.find((session) => session.id === sessionId);
    if (listedSession && this.isCurrentDirectorySession(listedSession)) {
      return listedSession;
    }

    const queryVariants = this.activeWorkspaceId
      ? [
          {
            sessionID: sessionId,
            directory: this.options.cwd,
            workspace: this.activeWorkspaceId,
          },
          {
            sessionID: sessionId,
            directory: this.options.cwd,
          },
        ]
      : [
          {
            sessionID: sessionId,
            directory: this.options.cwd,
          },
        ];

    for (const query of queryVariants) {
      try {
        const result = await this.client.session.get(query);
        if (result.error !== undefined || !result.data) {
          continue;
        }
        if (!this.isCurrentDirectorySession(result.data)) {
          return null;
        }
        return result.data;
      } catch {
        // Try the next query variant.
      }
    }

    return null;
  }

  /* ---- SSE event handling ---- */

  private startSseListener(): void {
    if (!this.client || this.sseLoopPromise) {
      return;
    }

    this.sseAbortController = new AbortController();
    this.sseLoopPromise = Promise.all([
      this.runSseLoop("event"),
      this.runSseLoop("global-event"),
      this.runSseLoop("global-sync"),
    ]).then(() => undefined);
  }

  private async runSseLoop(streamName: SdkEventStreamName): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const subscription = await this.subscribeToSseStream(streamName);
        const stream = subscription.stream;

        for await (const rawEvent of stream) {
          if (this.shuttingDown) {
            break;
          }
          const event = this.normalizeSdkEvent(rawEvent);
          if (!event || !this.shouldHandleSseEvent(event, streamName)) {
            continue;
          }
          if (this.shouldSkipDuplicateSdkEvent(event, streamName)) {
            continue;
          }
          this.handleSseEvent(event);
        }
      } catch (err) {
        if (this.shuttingDown) {
          return;
        }
        this.logDebug(
          `[opencode-adapter:${streamName}] Stream error: ${describeUnknownError(err)}`,
        );
      }

      if (this.shuttingDown) {
        return;
      }

      await delay(OPENCODE_SSE_RECONNECT_DELAY_MS);
    }
  }

  private subscribeToSseStream(streamName: SdkEventStreamName): Promise<SdkEventSubscription> {
    const signal = this.sseAbortController?.signal;
    if (streamName === "global-sync") {
      return this.client!.global.syncEvent.subscribe({ signal });
    }
    if (streamName === "global-event") {
      return this.client!.global.event({ signal });
    }
    return this.client!.event.subscribe(
      {
        directory: this.options.cwd,
        workspace: this.activeWorkspaceId ?? undefined,
      },
      { signal },
    );
  }

  private normalizeSdkEvent(rawEvent: unknown): NormalizedSdkEvent | null {
    if (!isRecord(rawEvent)) {
      return null;
    }

    if (typeof rawEvent.type === "string") {
      return rawEvent as NormalizedSdkEvent;
    }

    const payload = rawEvent.payload;
    if (isRecord(payload) && typeof payload.type === "string") {
      const normalized = { ...payload } as NormalizedSdkEvent;
      if (typeof rawEvent.directory === "string") {
        normalized.directory = rawEvent.directory;
      }
      return normalized;
    }

    return null;
  }

  private shouldHandleSseEvent(
    event: NormalizedSdkEvent,
    streamName: SdkEventStreamName,
  ): boolean {
    if (streamName === "event") {
      return true;
    }

    const type = this.normalizeEventType(event.type);
    if (streamName === "global-event") {
      if (
        type !== "tui.prompt.append" &&
        type !== "tui.command.execute" &&
        type !== "tui.session.select" &&
        type !== "command.executed" &&
        type !== "session.created" &&
        type !== "session.updated" &&
        type !== "session.deleted"
      ) {
        return false;
      }
      if (this.isImplicitLocalCompanionUiEvent(type)) {
        return true;
      }
      return (
        this.matchesCurrentDirectoryEvent(event) ||
        this.shouldAcceptUnscopedLocalSessionCreatedEvent(event)
      );
    }

    if (
      type === "session.created" ||
      type === "session.updated" ||
      type === "session.deleted"
    ) {
      return (
        this.matchesCurrentDirectoryEvent(event) ||
        (type === "session.created" &&
          this.shouldAcceptUnscopedLocalSessionCreatedEvent(event))
      );
    }

    return false;
  }

  private isImplicitLocalCompanionUiEvent(type: string): boolean {
    if (this.options.renderMode !== "companion") {
      return false;
    }

    return (
      type === "tui.prompt.append" ||
      type === "tui.command.execute" ||
      type === "tui.session.select"
    );
  }

  private handleSseEvent(event: SdkEvent): void {
    const type = this.normalizeEventType(event.type);
    const payload = this.extractEventPayload(event);

    if (type === "message.updated") {
      this.handleMessageUpdated(payload);
      return;
    }

    switch (type) {
      case "server.connected":
      case "server.heartbeat":
        return;

      case "session.idle": {
        this.handleSessionIdle(isRecord(payload) ? payload : undefined);
        return;
      }

      case "session.status": {
        this.handleSessionStatus(isRecord(payload) ? payload : undefined);
        return;
      }

      case "session.error": {
        this.handleSessionError(isRecord(payload) ? payload : undefined);
        return;
      }

      case "permission.updated":
      case "permission.asked": {
        this.handlePermissionRequest(payload);
        return;
      }

      case "session.created": {
        this.handleSessionCreated(payload);
        return;
      }

      case "session.updated": {
        this.handleSessionUpdated(payload);
        return;
      }

      case "message.updated": {
        // Full message update — not used for incremental text extraction.
        // Text output comes from message.part.updated events.
        return;
      }

      case "message.part.updated": {
        this.handleMessagePartUpdated(payload);
        return;
      }

      case "message.part.delta": {
        this.handleMessagePartDelta(payload);
        return;
      }

      case "message.part.removed": {
        this.handleMessagePartRemoved(payload);
        return;
      }

      case "tui.prompt.append": {
        this.handleTuiPromptAppend(payload);
        return;
      }

      case "tui.command.execute": {
        this.handleTuiCommandExecute(payload);
        return;
      }

      case "tui.session.select": {
        this.handleTuiSessionSelect(payload);
        return;
      }

      case "command.executed": {
        this.handleCommandExecuted(payload);
        return;
      }

      case "session.diff":
      case "session.diff.delta":
      case "session.deleted":
      case "message.removed":
      case "permission.replied":
      case "tui.toast.show":
        return;

      default:
        this.logUnknownEvent(type);
        return;
    }
  }

  private handleSessionIdle(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties) ?? this.activeSessionId;
    if (!this.syncTrackedSessionFromEvent(sessionId, { allowLocalTurnFollow: false })) {
      return;
    }

    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return;
    }

    // Wait a short settle time before emitting task_complete,
    // in case more events follow the idle signal.
    setTimeout(() => {
      if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
        return;
      }

      this.clearWechatWorkingNotice(true);
      this.pendingLocalPrompt = "";
      this.clearPendingPermissionState();
      this.state.activeTurnOrigin = undefined;
      this.hasAcceptedInput = false;
      const completedPreview = this.currentPreview;

      const turnStartedAtMs = this.lastBusyAtMs;
      const completingTurnToken = this.currentTurnToken;
      void this.outputBatcher.flushNow()
        .catch(() => undefined)
        .then(async () => {
          // A newer turn (local or wechat) may have started while we awaited
          // the flush. If so, this completion is stale: dropping it avoids
          // flipping the active turn back to idle, emitting the old final_reply,
          // and clearing the new turn's buffered output.
          if (this.currentTurnToken !== completingTurnToken) {
            return;
          }
          const finalReplyText = await this.resolveFinalReplyText(sessionId, turnStartedAtMs);
          if (this.currentTurnToken !== completingTurnToken) {
            return;
          }
          this.setStatus("idle");
          if (finalReplyText) {
            this.emit({
              type: "final_reply",
              text: finalReplyText,
              timestamp: nowIso(),
            });
          }

          this.emit({
            type: "task_complete",
            summary: completedPreview,
            timestamp: nowIso(),
          });
          this.currentPreview = "(idle)";
          this.outputBatcher.clear();
          this.clearStreamedPartState();
        });
    }, OPENCODE_SESSION_IDLE_SETTLE_MS).unref?.();
  }

  private handleSessionStatus(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (sessionId && !this.syncTrackedSessionFromEvent(sessionId)) {
      return;
    }

    // properties: { sessionID: string, status: { type: "busy" | "idle" | ... } }
    const status = properties.status;
    if (!isRecord(status)) {
      return;
    }

    const statusType = typeof status.type === "string" ? status.type : undefined;
    if (!statusType) {
      return;
    }

    if (statusType === "busy" || statusType === "running") {
      if (this.state.status === "idle") {
        this.outputBatcher.clear();
        this.clearStreamedPartState();
        this.lastBusyAtMs = Date.now();
        this.setStatus(
          "busy",
          this.state.activeTurnOrigin === "local"
            ? "OpenCode is busy with a local terminal turn."
            : undefined,
        );
      }
    }
  }

  private handlePermissionRequest(properties: unknown): void {
    if (!isRecord(properties) || !this.client) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (sessionId && !this.syncTrackedSessionFromEvent(sessionId)) {
      return;
    }

    const pendingPermission = this.buildPendingPermission(properties);
    if (!pendingPermission) {
      return;
    }

    this.clearWechatWorkingNotice();
    const denyMessage = this.getWechatOutboundAttachmentPermissionDenyMessage(
      properties,
      pendingPermission,
    );
    if (denyMessage) {
      this.rejectPermission(pendingPermission, denyMessage);
      return;
    }

    const approval = this.toPendingApproval(pendingPermission);
    this.pendingPermission = pendingPermission;
    this.state.pendingApproval = approval;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "OpenCode approval is required.");
    this.emit({
      type: "approval_required",
      request: approval,
      timestamp: nowIso(),
    });
  }

  private clearPendingPermissionState(): void {
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
  }

  private getWechatOutboundAttachmentPermissionDenyMessage(
    properties: Record<string, unknown>,
    pendingPermission: OpenCodePendingPermission,
  ): string | null {
    const metadata = isRecord(properties.metadata) ? properties.metadata : {};
    const command = this.extractPermissionCommand(properties, metadata);
    if (isWechatOutboundAttachmentWriteCommand(command)) {
      return WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE;
    }

    const targetPath = [
      command,
      typeof metadata.path === "string" ? metadata.path : "",
      typeof metadata.file === "string" ? metadata.file : "",
      typeof metadata.filePath === "string" ? metadata.filePath : "",
      typeof metadata.filepath === "string" ? metadata.filepath : "",
      typeof metadata.parentDir === "string" ? metadata.parentDir : "",
      typeof metadata.target === "string" ? metadata.target : "",
      typeof metadata.detail === "string" ? metadata.detail : "",
      Array.isArray(properties.patterns)
        ? properties.patterns.filter((value): value is string => typeof value === "string").join(" ")
        : "",
      typeof properties.pattern === "string" ? properties.pattern : "",
    ].join(" ");

    return isWechatOutboundAttachmentMutationTool(
      pendingPermission.request.toolName,
      targetPath,
    )
      ? WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE
      : null;
  }

  private rejectPermission(
    pendingPermission: OpenCodePendingPermission,
    denyMessage: string,
  ): void {
    const client = this.client;
    if (!client) {
      return;
    }

    void (async () => {
      try {
        const result = await client.permission.respond({
          sessionID: pendingPermission.sessionId,
          permissionID: pendingPermission.permissionId,
          directory: this.options.cwd,
          workspace: this.activeWorkspaceId ?? undefined,
          response: "reject",
        });
        if (result.error !== undefined) {
          throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
        }
      } catch (err) {
        this.emit({
          type: "stderr",
          text: `${denyMessage}\nFailed to reject permission: ${describeUnknownError(err)}`,
          timestamp: nowIso(),
        });
      }
    })();
  }

  private toPendingApproval(pendingPermission: OpenCodePendingPermission): PendingApproval {
    return {
      ...pendingPermission.request,
      code: pendingPermission.code,
      createdAt: pendingPermission.createdAt,
    };
  }

  private buildPendingPermission(
    properties: Record<string, unknown>,
  ): OpenCodePendingPermission | null {
    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : this.activeSessionId;
    const permissionId =
      typeof properties.id === "string"
        ? properties.id
        : undefined;

    if (!sessionId || !permissionId) {
      return null;
    }

    const toolName = this.extractPermissionToolName(properties);
    const title =
      typeof properties.title === "string"
        ? properties.title
        : typeof properties.permission === "string"
          ? `Permission request: ${properties.permission}`
          : undefined;
    const metadata = isRecord(properties.metadata) ? properties.metadata : {};
    const command = this.extractPermissionCommand(properties, metadata);

    return {
      sessionId,
      permissionId,
      code: buildOneTimeCode(),
      createdAt: nowIso(),
      request: {
        source: "cli",
        summary: title ?? `OpenCode needs approval${toolName ? ` for tool: ${toolName}` : ""}.`,
        commandPreview: truncatePreview(command ?? title ?? "Permission request", 180),
        toolName,
        detailPreview: typeof metadata.detail === "string" ? metadata.detail : undefined,
        detailLabel: typeof metadata.label === "string" ? metadata.label : undefined,
        confirmInput: undefined,
        denyInput: undefined,
      },
    };
  }

  private extractPermissionToolName(properties: Record<string, unknown>): string | undefined {
    return typeof properties.type === "string"
      ? properties.type
      : typeof properties.permission === "string"
        ? properties.permission
        : undefined;
  }

  private extractPermissionCommand(
    properties: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): string | undefined {
    if (typeof metadata.command === "string") {
      return metadata.command;
    }
    if (typeof metadata.detail === "string") {
      return metadata.detail;
    }
    if (Array.isArray(properties.patterns)) {
      const patterns = properties.patterns.filter(
        (value): value is string => typeof value === "string",
      );
      return patterns.length > 0 ? patterns.join(", ") : undefined;
    }
    return undefined;
  }

  private handleSessionCreated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const session = this.extractSessionReference(properties);
    if (this.syncTrackedSessionFromEvent(session)) {
      return;
    }
    if (!this.shouldFollowCreatedLocalSession(session)) {
      return;
    }

    this.pendingLocalSessionCreateFollowUntilMs = 0;
    this.logDebug(`[opencode-adapter:local-follow] session.created ${session.id}`);
    this.switchSharedSession(session, {
      source: "local",
      reason: "local_follow",
      notify: true,
      clearTrackedTurn: true,
      syncVisible: true,
    });
  }

  private handleSessionUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const session = this.extractSessionReference(properties);
    this.syncTrackedSessionFromEvent(session, { allowLocalTurnFollow: false });
  }

  private handleMessageUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (sessionId && !this.syncTrackedSessionFromEvent(sessionId, { allowLocalTurnFollow: false })) {
      return;
    }

    const info = isRecord(properties.info) ? properties.info : undefined;
    const messageId = typeof info?.id === "string" ? info.id : undefined;
    const role = info?.role === "user" || info?.role === "assistant" ? info.role : undefined;
    if (!messageId) {
      return;
    }

    const observed = this.getOrCreateObservedOpenCodeMessage(messageId, sessionId ?? undefined);
    observed.updatedAtMs = Date.now();
    observed.sessionId = sessionId ?? observed.sessionId;
    observed.role = role;

    if (role === "assistant") {
      this.cleanupObservedOpenCodeMessage(messageId);
      return;
    }

    this.tryEmitObservedLocalUserMessage(messageId);
  }

  private handleMessagePartUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const part = isRecord(properties.part) ? properties.part : undefined;
    const partId = this.extractPartId(properties, part);
    if (partId && typeof part?.type === "string") {
      this.partTypeByPartId.set(partId, part.type);
    }

    if (this.isVisibleTextPart(part)) {
      this.trackObservedOpenCodeMessagePart({
        messageId: part.messageID,
        sessionId: part.sessionID,
        partId: partId ?? part.id,
        snapshotText: typeof part.text === "string" ? part.text : undefined,
        deltaText: typeof properties.delta === "string" ? properties.delta : undefined,
      });
      if (this.observedOpenCodeMessages.get(part.messageID)?.role === "user") {
        return;
      }
    }

    if (this.state.status !== "busy") {
      return;
    }

    if (!this.isVisibleTextPart(part)) {
      return;
    }

    if (!this.syncTrackedSessionFromEvent(part.sessionID)) {
      return;
    }

    if (!partId) {
      return;
    }

    const partText =
      typeof part.text === "string"
        ? part.text
        : undefined;
    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;
    const text = partText
      ? this.consumeVisiblePartSnapshot(partId, partText)
      : delta
        ? this.consumeVisiblePartDelta(partId, delta)
        : "";
    const observedText =
      typeof part.messageID === "string"
        ? this.observedOpenCodeMessages.get(part.messageID)?.text
        : undefined;
    const observedRole =
      typeof part.messageID === "string"
        ? this.observedOpenCodeMessages.get(part.messageID)?.role
        : undefined;
    if (
      observedRole !== "assistant" &&
      this.matchesRecentLocalPromptMirror(observedText || partText || delta || text, {
        allowPrefix: true,
      })
    ) {
      return;
    }
    if (
      this.matchesRecentWechatPromptMirror(part.sessionID, observedText || partText || delta || text, {
        allowPrefix: true,
      })
    ) {
      return;
    }
    if (partText) {
      this.recordVisibleReplyPartSnapshot(partId, part.sessionID, part.messageID, partText);
    } else if (text) {
      this.recordVisibleReplyPartDelta(partId, part.sessionID, part.messageID, text);
    }
    this.pushVisibleOutput(text);
  }

  private handleMessagePartDelta(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    if (this.state.status !== "busy") {
      const sessionIdForTrackedMessage =
        typeof properties.sessionID === "string" ? properties.sessionID : undefined;
      const messageIdForTrackedMessage =
        typeof properties.messageID === "string" ? properties.messageID : undefined;
      const partIdForTrackedMessage =
        typeof properties.partID === "string" ? properties.partID : undefined;
      const deltaForTrackedMessage =
        typeof properties.delta === "string" ? properties.delta : undefined;
      if (messageIdForTrackedMessage && partIdForTrackedMessage && deltaForTrackedMessage) {
        this.trackObservedOpenCodeMessagePart({
          messageId: messageIdForTrackedMessage,
          sessionId: sessionIdForTrackedMessage,
          partId: partIdForTrackedMessage,
          deltaText: deltaForTrackedMessage,
        });
      }
      return;
    }

    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : undefined;
    const partId = this.extractPartId(properties);
    const knownPartType = partId ? this.partTypeByPartId.get(partId) : undefined;
    if (knownPartType && knownPartType !== "text") {
      return;
    }

    if (properties.field !== "text") {
      return;
    }

    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;

    if (typeof properties.messageID === "string" && partId && delta) {
      this.trackObservedOpenCodeMessagePart({
        messageId: properties.messageID,
        sessionId,
        partId,
        deltaText: delta,
      });
      if (this.observedOpenCodeMessages.get(properties.messageID)?.role === "user") {
        return;
      }
    }

    if (!delta || !partId || !this.syncTrackedSessionFromEvent(sessionId)) {
      return;
    }

    const text = this.consumeVisiblePartDelta(partId, delta);
    const observedText =
      typeof properties.messageID === "string"
        ? this.observedOpenCodeMessages.get(properties.messageID)?.text
        : undefined;
    const observedRole =
      typeof properties.messageID === "string"
        ? this.observedOpenCodeMessages.get(properties.messageID)?.role
        : undefined;
    if (
      observedRole !== "assistant" &&
      this.matchesRecentLocalPromptMirror(observedText || delta || text, {
        allowPrefix: true,
      })
    ) {
      return;
    }
    if (
      this.matchesRecentWechatPromptMirror(sessionId, observedText || delta || text, {
        allowPrefix: true,
      })
    ) {
      return;
    }
    this.recordVisibleReplyPartDelta(partId, sessionId, properties.messageID, text);
    this.pushVisibleOutput(text);
  }

  private handleMessagePartRemoved(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const partId = this.extractPartId(properties);
    if (!partId) {
      return;
    }

    this.emittedTextByPartId.delete(partId);
    this.partTypeByPartId.delete(partId);
    this.visibleReplyPartsByPartId.delete(partId);
  }

  private recordVisibleReplyPartSnapshot(
    partId: string,
    sessionId: string | undefined,
    messageId: unknown,
    text: string,
  ): void {
    const normalizedText = normalizeOutput(text);
    if (!normalizedText) {
      return;
    }

    const resolvedSessionId = sessionId ?? this.activeSessionId ?? undefined;
    if (!resolvedSessionId) {
      return;
    }

    const resolvedMessageId = typeof messageId === "string" ? messageId : undefined;
    this.visibleReplyPartsByPartId.set(partId, {
      sessionId: resolvedSessionId,
      messageId: resolvedMessageId,
      text: normalizedText,
    });
    if (resolvedMessageId) {
      this.visibleReplyMessageIds.add(resolvedMessageId);
    }
  }

  private recordVisibleReplyPartDelta(
    partId: string,
    sessionId: string | undefined,
    messageId: unknown,
    delta: string,
  ): void {
    const normalizedDelta = normalizeOutput(delta);
    if (!normalizedDelta) {
      return;
    }

    const previous = this.visibleReplyPartsByPartId.get(partId);
    this.recordVisibleReplyPartSnapshot(
      partId,
      sessionId ?? previous?.sessionId,
      messageId ?? previous?.messageId,
      `${previous?.text ?? ""}${normalizedDelta}`,
    );
  }

  private async resolveFinalReplyText(
    sessionId: string | null,
    turnStartedAtMs: number,
  ): Promise<string> {
    const sessionReply = sessionId
      ? await this.fetchLatestAssistantVisibleReply(sessionId, turnStartedAtMs)
      : "";
    if (sessionReply.trim()) {
      return sessionReply.trim();
    }

    const streamedReply = this.getBufferedVisibleReplyText(sessionId ?? undefined);
    if (streamedReply.trim()) {
      return streamedReply.trim();
    }

    const summary = this.outputBatcher.getRecentSummary(500);
    return summary && summary !== "(no output)" ? summary : "";
  }

  private getBufferedVisibleReplyText(sessionId: string | undefined): string {
    const chunks: string[] = [];
    for (const part of this.visibleReplyPartsByPartId.values()) {
      if (sessionId && part.sessionId !== sessionId) {
        continue;
      }
      if (part.text) {
        chunks.push(part.text);
      }
    }
    return normalizeOutput(chunks.join(""));
  }

  private async fetchLatestAssistantVisibleReply(
    sessionId: string,
    turnStartedAtMs: number,
  ): Promise<string> {
    const sessionClient = this.client?.session;
    if (!sessionClient?.messages) {
      return "";
    }

    const queryVariants = this.activeWorkspaceId
      ? [
          {
            sessionID: sessionId,
            directory: this.options.cwd,
            workspace: this.activeWorkspaceId,
            limit: 20,
          },
          {
            sessionID: sessionId,
            directory: this.options.cwd,
            limit: 20,
          },
        ]
      : [
          {
            sessionID: sessionId,
            directory: this.options.cwd,
            limit: 20,
          },
        ];

    for (const query of queryVariants) {
      try {
        const result = await sessionClient.messages(query);
        if (result.error !== undefined || !Array.isArray(result.data)) {
          continue;
        }

        const text = this.extractLatestAssistantVisibleReply(
          result.data,
          turnStartedAtMs,
          this.visibleReplyMessageIds,
        );
        if (text) {
          return text;
        }
      } catch {
        // Fall back to the streamed visible text buffer.
      }
    }

    return "";
  }

  private extractLatestAssistantVisibleReply(
    messages: SdkMessageRecord[],
    turnStartedAtMs: number,
    expectedMessageIds: ReadonlySet<string>,
  ): string {
    let best: { text: string; timeMs: number; index: number } | null = null;
    const minTimeMs = turnStartedAtMs > 0 ? turnStartedAtMs - 5_000 : 0;

    for (const [index, message] of messages.entries()) {
      if (!isRecord(message) || !isRecord(message.info)) {
        continue;
      }
      if (message.info.role !== "assistant") {
        continue;
      }

      const messageId = typeof message.info.id === "string" ? message.info.id : "";
      if (expectedMessageIds.size > 0 && !expectedMessageIds.has(messageId)) {
        continue;
      }

      const timeMs = this.extractMessageTimeMs(message.info);
      if (expectedMessageIds.size === 0 && (!timeMs || timeMs < minTimeMs)) {
        continue;
      }

      const text = this.extractVisibleTextFromParts(message.parts);
      if (!text.trim()) {
        continue;
      }

      const candidate = { text, timeMs: timeMs ?? 0, index };
      if (
        !best ||
        candidate.timeMs > best.timeMs ||
        (candidate.timeMs === best.timeMs && candidate.index > best.index)
      ) {
        best = candidate;
      }
    }

    return best?.text ?? "";
  }

  private extractVisibleTextFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) {
      return "";
    }

    return normalizeOutput(
      parts
        .filter((part): part is SdkPart => this.isVisibleTextPart(isRecord(part) ? part : undefined))
        .map((part) => part.text ?? "")
        .join(""),
    );
  }

  private extractMessageTimeMs(info: Record<string, unknown>): number | null {
    const time = isRecord(info.time) ? info.time : undefined;
    const rawTime =
      typeof time?.completed === "number"
        ? time.completed
        : typeof time?.created === "number"
          ? time.created
          : undefined;
    if (typeof rawTime !== "number" || !Number.isFinite(rawTime) || rawTime <= 0) {
      return null;
    }
    return rawTime < 1_000_000_000_000 ? rawTime * 1_000 : rawTime;
  }

  private handleTuiPromptAppend(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const text = typeof properties.text === "string" ? properties.text : undefined;
    if (!text) {
      return;
    }

    this.pendingLocalPrompt += text;
    this.maybeNotifyLocalPromptDraftStarted();
  }

  private handleTuiCommandExecute(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const command = typeof properties.command === "string" ? properties.command : undefined;
    if (!command) {
      return;
    }

    switch (command) {
      case "prompt.clear":
        this.pendingLocalPrompt = "";
        this.localPromptNoticeSent = false;
        return;
      case "prompt.submit":
        this.handleLocalPromptSubmit();
        return;
      default:
        if (this.isLocalSessionNavigationCommand(command)) {
          this.markPendingLocalSessionCreateFollow();
        }
        return;
    }
  }

  private handleTuiSessionSelect(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties) ?? undefined;
    if (!sessionId) {
      return;
    }

    if (sessionId === this.suppressedTuiSessionSelectId) {
      this.suppressedTuiSessionSelectId = null;
      return;
    }

    this.pendingLocalPrompt = "";
    this.localPromptNoticeSent = false;
    this.pendingLocalSessionCreateFollowUntilMs = 0;
    this.logDebug(`[opencode-adapter:local-follow] tui.session.select ${sessionId}`);
    this.switchSharedSession(
      {
        id: sessionId,
        workspaceID: this.extractWorkspaceId(properties) ?? undefined,
      },
      {
        source: "local",
        reason: "local_follow",
        notify: true,
        clearTrackedTurn: true,
        syncVisible: true,
      },
    );
  }

  private handleCommandExecuted(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const name = typeof properties.name === "string" ? properties.name : undefined;
    if (!this.isLocalSessionNavigationCommand(name)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (sessionId) {
      this.logDebug(`[opencode-adapter:local-follow] command.executed ${name} -> ${sessionId}`);
      this.switchSharedSession(
        {
          id: sessionId,
          workspaceID: this.extractWorkspaceId(properties) ?? undefined,
        },
        {
          source: "local",
          reason: "local_follow",
          notify: true,
          clearTrackedTurn: true,
          syncVisible: true,
        },
      );
      return;
    }

    this.markPendingLocalSessionCreateFollow();
  }

  private handleSessionError(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    const error = isRecord(properties.error) ? properties.error : undefined;
    const errorName = typeof error?.name === "string" ? error.name : undefined;
    const message = this.describeSessionError(error);
    if (!message) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (sessionId && !this.syncTrackedSessionFromEvent(sessionId, { allowLocalTurnFollow: false })) {
      return;
    }

    if (!this.hasTrackedTurnState()) {
      this.emit({
        type: "stderr",
        text: `OpenCode session error: ${message}`,
        timestamp: nowIso(),
      });
      return;
    }

    if (errorName === "MessageAbortedError") {
      this.settleTurnState();
      this.setStatus("idle");
      return;
    }

    this.failTrackedTurn(message);
  }

  private handleLocalPromptSubmit(): void {
    const prompt = normalizeOutput(this.pendingLocalPrompt).trim();
    this.pendingLocalPrompt = "";
    this.localPromptNoticeSent = false;
    if (!prompt) {
      return;
    }

    this.outputBatcher.clear();
    this.clearStreamedPartState();
    this.beginTrackedTurn(prompt, "local", {
      busyMessage: "OpenCode is busy with a local terminal turn.",
      emitMirroredUserInput: true,
    });
  }

  private trackObservedOpenCodeMessagePart(params: {
    messageId: string;
    sessionId?: string;
    partId: string;
    snapshotText?: string;
    deltaText?: string;
  }): void {
    const observed = this.getOrCreateObservedOpenCodeMessage(params.messageId, params.sessionId);
    observed.updatedAtMs = Date.now();
    observed.sessionId = params.sessionId ?? observed.sessionId;

    let chunk = "";
    if (typeof params.snapshotText === "string") {
      chunk = this.consumeObservedUserPartSnapshot(params.partId, params.snapshotText);
    } else if (typeof params.deltaText === "string") {
      chunk = this.consumeObservedUserPartDelta(params.partId, params.deltaText);
    }

    if (!chunk) {
      return;
    }

    let partIds = this.observedUserMessagePartIds.get(params.messageId);
    if (!partIds) {
      partIds = new Set<string>();
      this.observedUserMessagePartIds.set(params.messageId, partIds);
    }
    partIds.add(params.partId);
    observed.text = normalizeOutput(`${observed.text}${chunk}`);
    this.tryEmitObservedLocalUserMessage(params.messageId);
  }

  private getOrCreateObservedOpenCodeMessage(
    messageId: string,
    sessionId?: string,
  ): ObservedOpenCodeMessage {
    const existing = this.observedOpenCodeMessages.get(messageId);
    if (existing) {
      if (sessionId) {
        existing.sessionId = sessionId;
      }
      return existing;
    }

    const created: ObservedOpenCodeMessage = {
      sessionId: sessionId ?? this.activeSessionId ?? "",
      text: "",
      emitted: false,
      updatedAtMs: Date.now(),
    };
    this.observedOpenCodeMessages.set(messageId, created);
    return created;
  }

  private tryEmitObservedLocalUserMessage(messageId: string): void {
    const observed = this.observedOpenCodeMessages.get(messageId);
    if (!observed || observed.role !== "user" || observed.emitted) {
      return;
    }

    const text = normalizeOutput(observed.text).trim();
    if (!text) {
      return;
    }

    observed.emitted = true;
    if (
      this.shouldSuppressWechatMirroredPrompt(observed.sessionId, text) ||
      this.matchesRecentWechatPromptMirror(observed.sessionId, text)
    ) {
      this.cleanupObservedOpenCodeMessage(messageId);
      return;
    }
    if (this.wasRecentlyMirroredLocalPrompt(text)) {
      this.cleanupObservedOpenCodeMessage(messageId);
      return;
    }

    this.outputBatcher.clear();
    this.clearStreamedPartState();
    this.beginTrackedTurn(text, "local", {
      busyMessage: "OpenCode is busy with a local terminal turn.",
      emitMirroredUserInput: true,
    });
    this.cleanupObservedOpenCodeMessage(messageId);
  }

  private recordPendingWechatPromptMirrorSuppression(sessionId: string, text: string): void {
    const normalizedText = normalizeOutput(text).trim();
    if (!sessionId || !normalizedText) {
      return;
    }

    this.pruneWechatPromptMirrorSuppressions();
    const suppression = {
      sessionId,
      text: normalizedText,
      createdAtMs: Date.now(),
    };
    this.pendingWechatPromptMirrorSuppressions.push(suppression);
    this.recentWechatPromptMirrorSuppressions.push(suppression);
  }

  private shouldSuppressWechatMirroredPrompt(sessionId: string, text: string): boolean {
    const normalizedText = normalizeOutput(text).trim();
    if (!sessionId || !normalizedText) {
      return false;
    }

    this.pruneWechatPromptMirrorSuppressions();
    for (let index = this.pendingWechatPromptMirrorSuppressions.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingWechatPromptMirrorSuppressions[index]!;
      if (pending.sessionId === sessionId && pending.text === normalizedText) {
        this.pendingWechatPromptMirrorSuppressions.splice(index, 1);
        return true;
      }
    }

    return false;
  }

  private matchesRecentWechatPromptMirror(
    sessionId: string | undefined,
    text: string | undefined,
    options: { allowPrefix?: boolean } = {},
  ): boolean {
    const normalizedText = normalizeOutput(text ?? "").trim();
    if (!sessionId || !normalizedText) {
      return false;
    }

    this.pruneWechatPromptMirrorSuppressions();
    return this.recentWechatPromptMirrorSuppressions.some((pending) => {
      if (pending.sessionId !== sessionId) {
        return false;
      }
      if (pending.text === normalizedText) {
        return true;
      }
      return options.allowPrefix === true && pending.text.startsWith(normalizedText);
    });
  }

  private pruneWechatPromptMirrorSuppressions(): void {
    const cutoff = Date.now() - OPENCODE_WECHAT_MIRROR_SUPPRESSION_TTL_MS;
    for (let index = this.pendingWechatPromptMirrorSuppressions.length - 1; index >= 0; index -= 1) {
      if (this.pendingWechatPromptMirrorSuppressions[index]!.createdAtMs < cutoff) {
        this.pendingWechatPromptMirrorSuppressions.splice(index, 1);
      }
    }
    for (let index = this.recentWechatPromptMirrorSuppressions.length - 1; index >= 0; index -= 1) {
      if (this.recentWechatPromptMirrorSuppressions[index]!.createdAtMs < cutoff) {
        this.recentWechatPromptMirrorSuppressions.splice(index, 1);
      }
    }
  }

  private wasRecentlyMirroredLocalPrompt(text: string): boolean {
    return this.matchesRecentLocalPromptMirror(text);
  }

  private matchesRecentLocalPromptMirror(
    text: string | undefined,
    options: { allowPrefix?: boolean } = {},
  ): boolean {
    const normalizedText = normalizeOutput(text ?? "").trim();
    if (!normalizedText) {
      return false;
    }

    if (
      this.state.activeTurnOrigin === "local" &&
      this.hasAcceptedInput &&
      this.lastMirroredLocalPrompt &&
      this.lastMirroredLocalPrompt.createdAtMs >= Date.now() - OPENCODE_RECENT_LOCAL_PROMPT_TTL_MS &&
      (
        this.lastMirroredLocalPrompt.text === normalizedText ||
        (
          options.allowPrefix === true &&
          this.lastMirroredLocalPrompt.text.startsWith(normalizedText)
        )
      )
    ) {
      return true;
    }

    return false;
  }

  /* ---- Session helpers ---- */

  private unwrapOrThrow<T>(result: SdkResult<T>): T {
    if (result.error !== undefined) {
      throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
    }
    return result.data as T;
  }

  private async ensureSession(): Promise<SdkSession> {
    if (this.activeSessionId && this.client) {
      const session = await this.getSessionForCurrentDirectory(this.activeSessionId);
      if (session) {
        return session;
      }
      this.activeSessionId = null;
    }

    if (!this.client) {
      throw new Error("OpenCode SDK client is not initialized.");
    }

    const session = this.unwrapOrThrow(
      await this.client.session.create({
        directory: this.options.cwd,
        workspace: this.activeWorkspaceId ?? undefined,
      }),
    );
    return session;
  }

  private beginTrackedTurn(
    text: string,
    origin: BridgeTurnOrigin,
    options: {
      busyMessage?: string;
      emitMirroredUserInput?: boolean;
    } = {},
  ): void {
    this.currentTurnToken += 1;
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = origin;
    this.lastBusyAtMs = Date.now();
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy", options.busyMessage);

    if (options.emitMirroredUserInput && origin === "local") {
      this.lastMirroredLocalPrompt = {
        text: normalizeOutput(text).trim(),
        createdAtMs: Date.now(),
      };
      this.emit({
        type: "mirrored_user_input",
        text,
        origin: "local",
        timestamp: nowIso(),
      });
    }

    if (origin === "wechat") {
      this.armWechatWorkingNotice();
    }
  }

  private hasTrackedTurnState(): boolean {
    return (
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.hasAcceptedInput ||
      this.pendingPermission !== null ||
      this.state.activeTurnOrigin !== undefined ||
      this.currentPreview !== "(idle)"
    );
  }

  private settleTurnState(): void {
    this.clearWechatWorkingNotice(true);
    this.pendingLocalPrompt = "";
    this.localPromptNoticeSent = false;
    this.clearPendingPermissionState();
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.currentPreview = "(idle)";
    this.outputBatcher.clear();
    this.clearStreamedPartState();
  }

  private clearObservedMessageTracking(): void {
    this.observedOpenCodeMessages.clear();
    this.observedUserTextByPartId.clear();
    this.observedUserMessagePartIds.clear();
    this.pendingWechatPromptMirrorSuppressions.length = 0;
    this.recentWechatPromptMirrorSuppressions.length = 0;
    this.lastMirroredLocalPrompt = null;
  }

  private clearTrackedTurnForLocalSessionSwitch(): void {
    if (!this.hasTrackedTurnState()) {
      return;
    }

    this.settleTurnState();
    if (this.state.status !== "idle") {
      this.setStatus("idle");
    }
  }

  private failTrackedTurn(message: string): void {
    if (!this.hasTrackedTurnState()) {
      return;
    }

    this.settleTurnState();
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message,
      timestamp: nowIso(),
    });
  }

  private describeSessionError(error: Record<string, unknown> | undefined): string | null {
    if (!error) {
      return "OpenCode reported an unknown session error.";
    }

    const name = typeof error.name === "string" ? error.name : "UnknownError";
    const data = isRecord(error.data) ? error.data : undefined;
    const message = typeof data?.message === "string" ? data.message.trim() : "";
    const providerId = typeof data?.providerID === "string" ? data.providerID : undefined;

    if (name === "ProviderAuthError") {
      return providerId
        ? `Authentication is required for provider "${providerId}".${message ? ` ${message}` : ""}`.trim()
        : message || "Authentication is required for the configured provider.";
    }

    return message || name;
  }

  /* ---- Working notice ---- */

  private armWechatWorkingNotice(): void {
    this.clearWechatWorkingNotice();
    if (
      this.workingNoticeSent ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      this.pendingPermission ||
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
        this.pendingPermission ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      this.workingNoticeSent = true;
      this.emit({
        type: "notice",
        text: `OpenCode is still working on:\n${this.currentPreview}`,
        level: "info",
        timestamp: nowIso(),
      });
    }, this.workingNoticeDelayMs);
    this.workingNoticeTimer.unref?.();
  }

  private clearWechatWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
    }
  }

  /* ---- Output batching ---- */

  private flushOutputBatch(text: string): void {
    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });
  }

  /* ---- Core helpers ---- */

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  private assignActiveSession(
    session: { id: string; workspaceID?: string } | string | null | undefined,
  ): boolean {
    const sessionId = typeof session === "string" ? session : session?.id;
    if (!sessionId) {
      return false;
    }

    const changed = sessionId !== this.activeSessionId;
    this.activeSessionId = sessionId;
    if (typeof session !== "string" && session?.workspaceID) {
      this.activeWorkspaceId = session.workspaceID;
    }
    this.state.sharedSessionId = sessionId;
    this.state.sharedThreadId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;
    return changed;
  }

  private syncTrackedSessionFromEvent(
    session: { id: string; workspaceID?: string } | string | null | undefined,
    options: {
      allowLocalTurnFollow?: boolean;
    } = {},
  ): boolean {
    const sessionId = typeof session === "string" ? session : session?.id;
    if (!sessionId) {
      return false;
    }

    if (sessionId === this.activeSessionId) {
      this.assignActiveSession(session);
      return true;
    }

    if (options.allowLocalTurnFollow !== false && this.shouldFollowLocalTurnSession(sessionId)) {
      this.switchSharedSession(session ?? sessionId, {
        source: "local",
        reason: "local_turn",
        notify: true,
        syncVisible: true,
      });
      return true;
    }

    return false;
  }

  private extractSessionReference(
    properties: Record<string, unknown>,
  ): { id: string; workspaceID?: string } | null {
    if (typeof properties.sessionID === "string" || typeof properties.sessionId === "string") {
      const id =
        typeof properties.sessionID === "string"
          ? properties.sessionID
          : String(properties.sessionId);
      return {
        id,
        workspaceID: this.extractWorkspaceId(properties) ?? undefined,
      };
    }

    const session = isRecord(properties.session) ? properties.session : undefined;
    if (typeof session?.id === "string") {
      return {
        id: session.id,
        workspaceID: this.extractWorkspaceId(session) ?? this.extractWorkspaceId(properties) ?? undefined,
      };
    }

    const info = isRecord(properties.info) ? properties.info : undefined;
    if (typeof info?.id === "string") {
      return {
        id: info.id,
        workspaceID: this.extractWorkspaceId(info) ?? this.extractWorkspaceId(properties) ?? undefined,
      };
    }

    return null;
  }

  private extractSessionId(properties: Record<string, unknown>): string | null {
    return this.extractSessionReference(properties)?.id ?? null;
  }

  private extractWorkspaceId(properties: Record<string, unknown>): string | null {
    if (typeof properties.workspaceID === "string") {
      return properties.workspaceID;
    }

    const session = isRecord(properties.session) ? properties.session : undefined;
    if (typeof session?.workspaceID === "string") {
      return session.workspaceID;
    }

    const info = isRecord(properties.info) ? properties.info : undefined;
    if (typeof info?.workspaceID === "string") {
      return info.workspaceID;
    }

    return null;
  }

  private shouldFollowLocalTurnSession(sessionId: string): boolean {
    return (
      sessionId !== this.activeSessionId &&
      this.state.activeTurnOrigin === "local" &&
      this.hasTrackedTurnState()
    );
  }

  private markPendingLocalSessionCreateFollow(): void {
    this.pendingLocalSessionCreateFollowUntilMs =
      Date.now() + OPENCODE_LOCAL_SESSION_CREATE_FOLLOW_TTL_MS;
  }

  private hasPendingLocalSessionCreateFollow(): boolean {
    return Date.now() <= this.pendingLocalSessionCreateFollowUntilMs;
  }

  private shouldAcceptUnscopedLocalSessionCreatedEvent(event: NormalizedSdkEvent): boolean {
    if (this.normalizeEventType(event.type) !== "session.created") {
      return false;
    }
    if (this.options.renderMode !== "companion") {
      return false;
    }

    const payload = this.extractEventPayload(event);
    if (!isRecord(payload)) {
      return false;
    }

    const session = this.extractSessionReference(payload);
    if (!session?.id || session.id === this.activeSessionId) {
      return false;
    }

    if (
      typeof event.directory === "string" ||
      this.extractSessionDirectory(payload) ||
      this.extractWorkspaceId(payload)
    ) {
      return false;
    }

    return this.hasPendingLocalSessionCreateFollow() || Boolean(this.activeSessionId);
  }

  private shouldFollowCreatedLocalSession(
    session: { id: string; workspaceID?: string } | null,
  ): session is { id: string; workspaceID?: string } {
    if (!session?.id || session.id === this.activeSessionId) {
      return false;
    }

    if (this.hasPendingLocalSessionCreateFollow()) {
      this.pendingLocalSessionCreateFollowUntilMs = 0;
      return true;
    }

    this.pendingLocalSessionCreateFollowUntilMs = 0;
    return Boolean(this.activeSessionId);
  }

  private switchSharedSession(
    session: { id: string; workspaceID?: string } | string,
    options: {
      source: BridgeSessionSwitchSource;
      reason: BridgeSessionSwitchReason;
      notify?: boolean;
      clearTrackedTurn?: boolean;
      syncVisible?: boolean;
      forceVisibleSync?: boolean;
      retryVisibleSync?: boolean;
    },
  ): boolean {
    const sessionId = typeof session === "string" ? session : session.id;
    if (!sessionId) {
      return false;
    }

    const changed = this.assignActiveSession(session);
    if (changed && options.clearTrackedTurn) {
      this.clearTrackedTurnForLocalSessionSwitch();
    }
    if (changed) {
      this.recordSessionSwitch(sessionId, options.source, options.reason, options.notify);
    }
    if (options.syncVisible !== false && (changed || options.forceVisibleSync)) {
      void this.syncVisibleSessionSelection(typeof session === "string" ? { id: session } : session, {
        retry: options.retryVisibleSync,
      });
    }
    return changed;
  }

  private async syncVisibleSessionToShared(
    options: { force?: boolean; retry?: boolean } = {},
  ): Promise<void> {
    if (!this.activeSessionId) {
      return;
    }

    await this.syncVisibleSessionSelection(
      {
        id: this.activeSessionId,
        workspaceID: this.activeWorkspaceId ?? undefined,
      },
      { force: options.force, retry: options.retry },
    );
  }

  private async syncVisibleSessionSelection(
    session: { id: string; workspaceID?: string },
    options: {
      force?: boolean;
      retry?: boolean;
    } = {},
  ): Promise<void> {
    if (
      !this.client?.tui ||
      this.options.renderMode !== "companion" ||
      (!options.force && session.id === this.suppressedTuiSessionSelectId)
    ) {
      return;
    }

    this.suppressedTuiSessionSelectId = session.id;
    this.logDebug(
      `[opencode-adapter:tui] selectSession session=${session.id} workspace=${session.workspaceID ?? this.activeWorkspaceId ?? "(none)"}`,
    );

    try {
      await this.sendVisibleSessionSelection(session);
      if (options.retry === true) {
        this.scheduleVisibleSessionSelectionRetries(session);
      }
    } catch (err) {
      if (this.suppressedTuiSessionSelectId === session.id) {
        this.suppressedTuiSessionSelectId = null;
      }
      this.logDebug(
        `[opencode-adapter:tui] selectSession failed for ${session.id}: ${describeUnknownError(err)}`,
      );
    }
  }

  private async sendVisibleSessionSelection(
    session: { id: string; workspaceID?: string },
  ): Promise<void> {
    if (!this.client?.tui) {
      return;
    }

    const result = await this.client.tui.selectSession({
      directory: this.options.cwd,
      workspace: session.workspaceID ?? this.activeWorkspaceId ?? undefined,
      sessionID: session.id,
    });
    if (result.error !== undefined) {
      throw result.error;
    }
  }

  private scheduleVisibleSessionSelectionRetries(
    session: { id: string; workspaceID?: string },
  ): void {
    for (const retryDelayMs of OPENCODE_TUI_SELECT_RETRY_DELAYS_MS) {
      setTimeout(() => {
        if (
          this.shuttingDown ||
          this.options.renderMode !== "companion" ||
          this.activeSessionId !== session.id
        ) {
          return;
        }
        void this.sendVisibleSessionSelection(session).catch((err) => {
          this.logDebug(
            `[opencode-adapter:tui] selectSession retry failed for ${session.id}: ${describeUnknownError(err)}`,
          );
        });
      }, retryDelayMs).unref?.();
    }
  }

  private isLocalSessionNavigationCommand(command: string | undefined): boolean {
    if (!command) {
      return false;
    }

    const normalized = command.trim().toLowerCase();
    return (
      normalized === "session" ||
      normalized === "new" ||
      normalized === "/session" ||
      normalized === "/new" ||
      normalized.startsWith("session.") ||
      normalized.startsWith("/session ")
    );
  }

  private normalizeEventType(type: string): string {
    return type.endsWith(".1") ? type.slice(0, -2) : type;
  }

  private extractEventPayload(event: SdkEvent): unknown {
    const syncEvent = event as SdkEvent & { data?: unknown };
    return syncEvent.properties ?? syncEvent.data;
  }

  private matchesCurrentDirectoryEvent(event: SdkEvent): boolean {
    const payload = this.extractEventPayload(event);
    const eventRecord = event as unknown as { directory?: unknown };
    const wrappedDirectory =
      typeof eventRecord.directory === "string"
        ? eventRecord.directory
        : undefined;
    if (wrappedDirectory) {
      const matchesWrappedDirectory =
        this.normalizeDirectory(wrappedDirectory) === this.normalizeDirectory(this.options.cwd);
      if (!matchesWrappedDirectory) {
        return false;
      }
    }

    if (!isRecord(payload)) {
      return Boolean(wrappedDirectory);
    }

    const directory = this.extractSessionDirectory(payload);
    if (directory) {
      const matchesDirectory =
        this.normalizeDirectory(directory) === this.normalizeDirectory(this.options.cwd);
      if (!matchesDirectory) {
        return false;
      }
    }

    const workspaceId = this.extractWorkspaceId(payload);
    if (workspaceId && this.activeWorkspaceId && workspaceId !== this.activeWorkspaceId) {
      this.logDebug(
        `[opencode-adapter:sse] Ignored workspace mismatch session=${this.extractSessionId(payload) ?? "(unknown)"} eventWorkspace=${workspaceId} activeWorkspace=${this.activeWorkspaceId}`,
      );
      return false;
    }

    if (wrappedDirectory || directory || workspaceId) {
      return true;
    }

    const sessionId = this.extractSessionId(payload);
    return Boolean(
      sessionId &&
        (sessionId === this.activeSessionId || sessionId === this.state.sharedSessionId),
    );
  }

  private extractSessionDirectory(properties: Record<string, unknown>): string | null {
    if (typeof properties.directory === "string") {
      return properties.directory;
    }

    const session = isRecord(properties.session) ? properties.session : undefined;
    if (typeof session?.directory === "string") {
      return session.directory;
    }

    const info = isRecord(properties.info) ? properties.info : undefined;
    if (typeof info?.directory === "string") {
      return info.directory;
    }

    return null;
  }

  private isCurrentDirectorySession(session: SdkSession): boolean {
    if (this.normalizeDirectory(session.directory) !== this.normalizeDirectory(this.options.cwd)) {
      return false;
    }

    if (session.workspaceID && this.activeWorkspaceId && session.workspaceID !== this.activeWorkspaceId) {
      return false;
    }

    return true;
  }

  private normalizeDirectory(directory: string): string {
    return directory.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
  }

  private recordSessionSwitch(
    sessionId: string,
    source: BridgeSessionSwitchSource,
    reason: BridgeSessionSwitchReason,
    notify = false,
  ): void {
    const timestamp = nowIso();
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    if (!notify) {
      return;
    }

    this.emit({
      type: "session_switched",
      sessionId,
      source,
      reason,
      timestamp,
    });
  }

  private getServerUrl(): string {
    return `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
  }

  private isVisibleTextPart(part: Record<string, unknown> | undefined): part is SdkPart {
    return !!part && part.type === "text" && part.ignored !== true;
  }

  private extractPartId(
    properties: Record<string, unknown>,
    part?: Record<string, unknown> | undefined,
  ): string | null {
    if (typeof properties.partID === "string") {
      return properties.partID;
    }

    if (typeof part?.id === "string") {
      return part.id;
    }

    return null;
  }

  private consumeVisiblePartSnapshot(partId: string, text: string): string {
    const nextText = normalizeOutput(text);
    if (!nextText) {
      return "";
    }

    const previousText = this.emittedTextByPartId.get(partId) ?? "";
    if (nextText === previousText) {
      return "";
    }

    this.emittedTextByPartId.set(partId, nextText);
    if (!previousText) {
      return nextText;
    }

    if (nextText.startsWith(previousText)) {
      return nextText.slice(previousText.length);
    }

    const sharedPrefixLength = this.getSharedPrefixLength(previousText, nextText);
    return nextText.slice(sharedPrefixLength);
  }

  private consumeVisiblePartDelta(partId: string, delta: string): string {
    const nextChunk = normalizeOutput(delta);
    if (!nextChunk) {
      return "";
    }

    const previousText = this.emittedTextByPartId.get(partId) ?? "";
    if (nextChunk === previousText || previousText.endsWith(nextChunk)) {
      return "";
    }

    if (previousText && nextChunk.startsWith(previousText)) {
      this.emittedTextByPartId.set(partId, nextChunk);
      return nextChunk.slice(previousText.length);
    }

    this.emittedTextByPartId.set(partId, `${previousText}${nextChunk}`);
    return nextChunk;
  }

  private consumeObservedUserPartSnapshot(partId: string, text: string): string {
    const nextText = normalizeOutput(text);
    if (!nextText) {
      return "";
    }

    const previousText = this.observedUserTextByPartId.get(partId) ?? "";
    if (nextText === previousText) {
      return "";
    }

    this.observedUserTextByPartId.set(partId, nextText);
    if (!previousText) {
      return nextText;
    }

    if (nextText.startsWith(previousText)) {
      return nextText.slice(previousText.length);
    }

    const sharedPrefixLength = this.getSharedPrefixLength(previousText, nextText);
    return nextText.slice(sharedPrefixLength);
  }

  private consumeObservedUserPartDelta(partId: string, delta: string): string {
    const nextChunk = normalizeOutput(delta);
    if (!nextChunk) {
      return "";
    }

    const previousText = this.observedUserTextByPartId.get(partId) ?? "";
    if (nextChunk === previousText || previousText.endsWith(nextChunk)) {
      return "";
    }

    if (previousText && nextChunk.startsWith(previousText)) {
      this.observedUserTextByPartId.set(partId, nextChunk);
      return nextChunk.slice(previousText.length);
    }

    this.observedUserTextByPartId.set(partId, `${previousText}${nextChunk}`);
    return nextChunk;
  }

  private pushVisibleOutput(text: string): void {
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.outputBatcher.push(text);
  }

  private clearStreamedPartState(): void {
    this.emittedTextByPartId.clear();
    this.partTypeByPartId.clear();
    this.visibleReplyPartsByPartId.clear();
    this.visibleReplyMessageIds.clear();
  }

  private cleanupObservedOpenCodeMessage(messageId: string): void {
    this.observedOpenCodeMessages.delete(messageId);
    const partIds = this.observedUserMessagePartIds.get(messageId);
    if (partIds) {
      for (const partId of partIds) {
        this.observedUserTextByPartId.delete(partId);
      }
      this.observedUserMessagePartIds.delete(messageId);
    }
  }

  private getSharedPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  private logDebug(message: string): void {
    if (!OPENCODE_DEBUG_ENABLED) {
      return;
    }
    process.stderr.write(`${message}\n`);
  }

  private logUnknownEvent(type: string): void {
    if (!OPENCODE_DEBUG_ENABLED || this.loggedUnknownEventTypes.has(type)) {
      return;
    }
    this.loggedUnknownEventTypes.add(type);
    this.logDebug(`[opencode-adapter:sse] Unknown event: ${type}`);
  }

  private shouldSkipDuplicateSdkEvent(
    event: NormalizedSdkEvent,
    streamName: SdkEventStreamName,
  ): boolean {
    const key = this.getDuplicateSdkEventKey(event);
    if (!key) {
      return false;
    }

    const now = Date.now();
    const cutoff = now - OPENCODE_DUPLICATE_EVENT_TTL_MS;
    for (const [candidateKey, observed] of this.recentSdkEventObservations.entries()) {
      if (observed.observedAtMs < cutoff) {
        this.recentSdkEventObservations.delete(candidateKey);
      }
    }

    const previous = this.recentSdkEventObservations.get(key);
    this.recentSdkEventObservations.set(key, { streamName, observedAtMs: now });
    return Boolean(previous && previous.streamName !== streamName && previous.observedAtMs >= cutoff);
  }

  private getDuplicateSdkEventKey(event: NormalizedSdkEvent): string | null {
    const type = this.normalizeEventType(event.type);
    const payload = this.extractEventPayload(event);
    if (!isRecord(payload)) {
      return null;
    }

    switch (type) {
      case "tui.prompt.append": {
        const text = typeof payload.text === "string" ? payload.text : undefined;
        return text ? `${type}:${text}` : null;
      }
      case "tui.command.execute": {
        const command = typeof payload.command === "string" ? payload.command : undefined;
        return command ? `${type}:${command}` : null;
      }
      case "tui.session.select": {
        const sessionId = typeof payload.sessionID === "string" ? payload.sessionID : undefined;
        return sessionId ? `${type}:${sessionId}` : null;
      }
      case "command.executed": {
        const name = typeof payload.name === "string" ? payload.name : undefined;
        const sessionId = this.extractSessionId(payload) ?? "";
        const args = typeof payload.arguments === "string" ? payload.arguments : "";
        return name ? `${type}:${name}:${sessionId}:${args}` : null;
      }
      case "session.created":
      case "session.updated":
      case "session.deleted": {
        const sessionId = this.extractSessionId(payload);
        return sessionId ? `${type}:${sessionId}` : null;
      }
      default:
        return null;
    }
  }

  private maybeNotifyLocalPromptDraftStarted(): void {
    if (this.localPromptNoticeSent) {
      return;
    }

    const preview = truncatePreview(normalizeOutput(this.pendingLocalPrompt).trim(), 180);
    if (!preview) {
      return;
    }

    this.localPromptNoticeSent = true;
    this.emit({
      type: "notice",
      text: `OpenCode local draft:\n${preview}`,
      level: "info",
      timestamp: nowIso(),
    });
  }

  private setStatus(
    status: BridgeAdapterState["status"],
    message?: string,
  ): void {
    this.state.status = status;
    this.emit({
      type: "status",
      status,
      message,
      timestamp: nowIso(),
    });
  }
}
