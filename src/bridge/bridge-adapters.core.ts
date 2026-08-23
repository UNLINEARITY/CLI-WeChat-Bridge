import net from "node:net";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import type { IPty } from "node-pty";
import { t } from "../i18n/index.ts";
import {
  attachLocalCompanionMessageListener,
  buildLocalCompanionToken,
  clearLocalCompanionEndpoint,
  clearLocalCompanionOccupancy,
  sendLocalCompanionMessage,
  updateLocalCompanionOccupancy,
  writeLocalCompanionEndpoint,
  type LocalCompanionCloseReason,
  type LocalCompanionCommand,
  type LocalCompanionEndpoint,
  type LocalCompanionMessage,
} from "../companion/local-companion-link.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeEvent,
  BridgeLifecycleMode,
  BridgeResumeSessionCandidate,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";
import * as shared from "./bridge-adapters.shared.ts";
import { LOCAL_CLIENT_PROTOCOL_VERSION } from "../runtime/runtime-types.ts";

type AdapterOptions = shared.AdapterOptions;
type EventSink = shared.EventSink;
type SpawnTarget = shared.SpawnTarget;

const {
  CODEX_APP_SERVER_HOST,
  INTERRUPT_SETTLE_DELAY_MS,
  buildCliEnvironment,
  buildPtySpawnOptions,
  buildSpawnDiagnostic,
  getLocalCompanionCommandName,
  getSharedSessionIdFromAdapterState,
  LOCAL_COMPANION_RECONNECT_GRACE_MS,
  resolveSpawnTarget,
  spawnFallbackProcess,
} = shared;

/**
 * On Windows, node-pty (ConPTY) uses CreateProcess which can execute .cmd/.bat
 * files directly — no need for the cmd.exe wrapper that resolveSpawnTarget adds
 * for child_process.spawn compatibility.  The wrapper causes double-quoting when
 * the script path contains spaces: node-pty quotes the already-quoted path,
 * making cmd.exe treat the literal quotes as part of the filename.
 */
function unwrapCmdExeForPty(rawTarget: SpawnTarget): SpawnTarget {
  if (process.platform !== "win32") {
    return rawTarget;
  }

  const fileName = path.basename(rawTarget.file).toLowerCase();
  if (fileName !== "cmd.exe") {
    return rawTarget;
  }

  const args = rawTarget.args;
  if (args.length < 4 || args[0] !== "/d" || args[1] !== "/s" || args[2] !== "/c") {
    return rawTarget;
  }

  // Strip surrounding double-quotes from the /c argument to recover the
  // actual script path.  quoteForCmd wraps paths containing spaces in
  // double-quotes, so we reverse that here.
  const commandLine = args[3] ?? "";
  const actualScript = commandLine.replace(/^"(.*)"$/s, "$1");

  // Remaining args beyond the /c handler (args[4..]) are extra arguments
  // that were passed through wrapWithCmdExe; forward them as the new target's
  // args so they stay prepended before buildSpawnArgs().
  return {
    file: actualScript,
    args: args.slice(4),
  };
}

export class LocalCompanionProxyAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  // Pending senders waiting for the companion's first state frame.
  private readonly readyWaiters = new Set<{
    timer: NodeJS.Timeout;
    settle: (error?: Error) => void;
  }>();
  private detachMessageListener: (() => void) | null = null;
  private requestCounter = 0;
  private endpoint: LocalCompanionEndpoint | null = null;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private shuttingDown = false;
  private expectedCloseReason: LocalCompanionCloseReason | null = null;
  private reconnectShutdownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    const shouldRestoreInitialSession = options.sessionStartMode !== "new";
    const initialSharedSessionId = shouldRestoreInitialSession
      ? options.initialSharedSessionId ?? options.initialSharedThreadId
      : undefined;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
      sharedSessionId: initialSharedSessionId,
      sharedThreadId:
        options.kind === "codex" || options.kind === "opencode"
          ? initialSharedSessionId
          : undefined,
      activeRuntimeSessionId:
        options.kind === "claude" || options.kind === "opencode" || options.kind === "pi"
          ? initialSharedSessionId
          : undefined,
      resumeConversationId:
        shouldRestoreInitialSession && options.kind === "claude"
          ? options.initialResumeConversationId
          : undefined,
      transcriptPath:
        shouldRestoreInitialSession && options.kind === "claude"
          ? options.initialTranscriptPath
          : undefined,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.shuttingDown = false;
    this.expectedCloseReason = null;
    this.clearReconnectShutdownTimer();
    this.setStatus(
      "starting",
      formatLocalCompanionStartupMessage({
        kind: this.options.kind,
        launchMode: this.options.companionLaunchMode,
      }),
    );

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handlePanelSocket(socket);
      });
      this.server = server;
      server.on("error", (error) => {
        // Roll back the half-initialized server: start() early-returns while
        // this.server is set, so a leftover handle would make every retry
        // silently "succeed" without ever listening.
        if (this.server === server) {
          this.server = null;
        }
        server.close();
        reject(error);
      });
      server.listen(0, CODEX_APP_SERVER_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          if (this.server === server) {
            this.server = null;
          }
          server.close();
          reject(new Error(`Failed to allocate a local ${this.options.kind} companion port.`));
          return;
        }

        this.endpoint = {
          protocolVersion: LOCAL_CLIENT_PROTOCOL_VERSION,
          runtimeKind: "legacy_adapter",
          instanceId: `${process.pid}-${Date.now().toString(36)}`,
          kind: this.options.kind,
          port: address.port,
          token: buildLocalCompanionToken(),
          cwd: this.options.cwd,
          command: this.options.command,
          profile: this.options.profile,
          sharedSessionId: getSharedSessionIdFromAdapterState(this.state),
          resumeConversationId: this.state.resumeConversationId,
          transcriptPath: this.state.transcriptPath,
          startedAt: nowIso(),
        };
        const endpoint = this.endpoint;
        writeLocalCompanionEndpoint(endpoint);
        resolve();
      });
    });
  }

  async sendInput(text: string): Promise<void> {
    await this.sendRequest({
      command: "send_input",
      text,
    });
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    const result = await this.sendRequest({
      command: "list_resume_sessions",
      limit,
    });
    return Array.isArray(result) ? (result as BridgeResumeSessionCandidate[]) : [];
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.sendRequest({
      command: "resume_session",
      sessionId,
    });
  }

  async createSession(): Promise<void> {
    await this.sendRequest({
      command: "create_session",
    });
  }

  async interrupt(): Promise<boolean> {
    const result = await this.sendRequest({
      command: "interrupt",
    });
    return Boolean(result);
  }

  async reset(): Promise<void> {
    await this.sendRequest({
      command: "reset",
    });
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    const result = await this.sendRequest({
      command: "resolve_approval",
      action,
    });
    return Boolean(result);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    const ok = await this.resolveApproval(action);
    return ok ? 1 : 0;
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    try {
      const result = await this.sendRequest({
        command: "submit_user_input",
        answers,
      });
      return result === true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.expectedCloseReason = null;
    this.clearReconnectShutdownTimer();
    this.rejectPendingRequests(`${this.options.kind} companion proxy is shutting down.`);
    clearLocalCompanionEndpoint(this.options.cwd, this.endpoint?.instanceId, {
      adapter: this.options.kind,
    });

    if (this.socket) {
      try {
        sendLocalCompanionMessage(this.socket, {
          type: "request",
          id: `${++this.requestCounter}`,
          payload: { command: "dispose" },
        });
      } catch {
        // Best effort.
      }
      this.detachPanelSocket();
    }

    if (!this.server) {
      this.state.status = "stopped";
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.state.status = "stopped";
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private handlePanelSocket(socket: net.Socket): void {
    if (!this.endpoint) {
      socket.destroy();
      return;
    }

    if (this.socket) {
      socket.end();
      socket.destroy();
      return;
    }

    let authenticated = false;
    socket.setNoDelay(true);
    const detachListener = attachLocalCompanionMessageListener(socket, (message) => {
      if (!authenticated) {
        if (
          message.type !== "hello" ||
          message.token !== this.endpoint?.token
        ) {
          socket.destroy();
          return;
        }

        authenticated = true;
        this.clearReconnectShutdownTimer();
        this.expectedCloseReason = null;
        this.socket = socket;
        this.detachMessageListener = detachListener;
        const companionConnectedAt = nowIso();
        if (this.endpoint) {
          this.endpoint.companionPid = message.companionPid;
          this.endpoint.companionConnectedAt = companionConnectedAt;
        }
        updateLocalCompanionOccupancy(
          this.options.cwd,
          {
            companionPid: message.companionPid,
            companionConnectedAt,
          },
          this.endpoint?.instanceId,
          { adapter: this.options.kind },
        );
        sendLocalCompanionMessage(socket, { type: "hello_ack" });
        return;
      }

      this.handlePanelMessage(message);
    });

    socket.once("close", () => {
      if (this.socket === socket) {
        const expectedCloseReason = this.expectedCloseReason;
        this.expectedCloseReason = null;
        clearLocalCompanionOccupancy(this.options.cwd, this.endpoint?.instanceId, {
          adapter: this.options.kind,
        });
        this.detachPanelSocket();
        if (!this.shuttingDown) {
          this.handleCompanionDisconnect(expectedCloseReason);
        }
      }
    });
    socket.once("error", () => {
      socket.destroy();
    });
  }

  private handlePanelMessage(message: LocalCompanionMessage): void {
    switch (message.type) {
      case "closing":
        this.expectedCloseReason = message.reason;
        return;
      case "event":
        this.eventSink(message.event);
        return;
      case "state":
        if (this.endpoint) {
          Object.assign(
            this.endpoint,
            buildCompanionHealthPatch(message.state, nowIso()),
          );
          const nextSessionId = getSharedSessionIdFromAdapterState(message.state);
          if (
            this.endpoint.sharedSessionId !== nextSessionId ||
            this.endpoint.resumeConversationId !== message.state.resumeConversationId ||
            this.endpoint.transcriptPath !== message.state.transcriptPath
          ) {
            this.endpoint.sharedSessionId = nextSessionId;
            this.endpoint.sharedThreadId =
              this.options.kind === "codex" || this.options.kind === "opencode" ? nextSessionId : undefined;
            this.endpoint.resumeConversationId = message.state.resumeConversationId;
            this.endpoint.transcriptPath = message.state.transcriptPath;
          }
          writeLocalCompanionEndpoint(this.endpoint);
        }
        this.state.pid = undefined;
        this.state.startedAt = undefined;
        this.state.lastInputAt = undefined;
        this.state.lastOutputAt = undefined;
        this.state.pendingApproval = null;
        this.state.sharedSessionId = undefined;
        this.state.sharedThreadId = undefined;
        this.state.activeRuntimeSessionId = undefined;
        this.state.resumeConversationId = undefined;
        this.state.transcriptPath = undefined;
        this.state.lastSessionSwitchAt = undefined;
        this.state.lastSessionSwitchSource = undefined;
        this.state.lastSessionSwitchReason = undefined;
        this.state.lastThreadSwitchAt = undefined;
        this.state.lastThreadSwitchSource = undefined;
        this.state.lastThreadSwitchReason = undefined;
        this.state.activeTurnId = undefined;
        this.state.activeTurnOrigin = undefined;
        this.state.pendingApprovalOrigin = undefined;
        Object.assign(this.state, message.state);
        if (this.state.pid) {
          this.settleReadyWaiters();
        }
        this.eventSink({
          type: "status",
          status: this.state.status,
          timestamp: nowIso(),
        });
        return;
      case "response": {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(message.id);
        if (!message.ok) {
          pending.reject(
            new Error(message.error ?? `Unknown ${this.options.kind} companion error.`),
          );
          return;
        }
        pending.resolve(message.result);
        return;
      }
    }
  }

  private detachPanelSocket(): void {
    this.settleReadyWaiters(
      new Error(formatCompanionNotConnectedMessage({
        kind: this.options.kind,
        launchMode: this.options.companionLaunchMode,
      })),
    );
    this.rejectPendingRequests("Companion socket disconnected unexpectedly.");
    this.detachMessageListener?.();
    this.detachMessageListener = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on("error", () => {});
      this.socket.destroy();
      this.socket = null;
    }
    this.state.pid = undefined;
    this.state.startedAt = undefined;
    this.state.lastInputAt = undefined;
    this.state.lastOutputAt = undefined;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
  }

  private handleCompanionDisconnect(
    expectedCloseReason: LocalCompanionCloseReason | null,
  ): void {
    const disposition = getCompanionDisconnectDisposition({
      kind: this.options.kind,
      lifecycle: this.options.lifecycle,
      expectedClose: isExpectedLocalCompanionClose(expectedCloseReason),
      reconnectGraceMs: LOCAL_COMPANION_RECONNECT_GRACE_MS,
      launchMode: this.options.companionLaunchMode,
    });

    if (disposition.action === "shutdown") {
      this.clearReconnectShutdownTimer();
      this.setStatus("stopped", disposition.message);
      this.eventSink({
        type: "shutdown_requested",
        reason: disposition.shutdownReason,
        message: disposition.message,
        timestamp: nowIso(),
      });
      return;
    }

    if (disposition.action === "wait_for_reconnect") {
      this.setStatus("starting", disposition.message);
      this.armReconnectShutdownTimer();
      return;
    }

    this.clearReconnectShutdownTimer();
    this.setStatus("starting", disposition.message);
  }

  private armReconnectShutdownTimer(): void {
    this.clearReconnectShutdownTimer();
    this.reconnectShutdownTimer = setTimeout(() => {
      this.reconnectShutdownTimer = null;
      if (this.shuttingDown || this.socket) {
        return;
      }

      const message = buildCompanionReconnectTimeoutMessage({
        kind: this.options.kind,
        reconnectGraceMs: LOCAL_COMPANION_RECONNECT_GRACE_MS,
      });
      this.setStatus("stopped", message);
      this.eventSink({
        type: "shutdown_requested",
        reason: "companion_reconnect_timeout",
        message,
        timestamp: nowIso(),
      });
    }, LOCAL_COMPANION_RECONNECT_GRACE_MS);
    this.reconnectShutdownTimer.unref?.();
  }

  private clearReconnectShutdownTimer(): void {
    if (!this.reconnectShutdownTimer) {
      return;
    }

    clearTimeout(this.reconnectShutdownTimer);
    this.reconnectShutdownTimer = null;
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.eventSink({
      type: "status",
      status,
      message,
      timestamp: nowIso(),
    });
  }

  private rejectPendingRequests(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  /**
   * Wait for the companion's first state frame (which reports the worker
   * pid). The companion sends it only after its adapter finished starting —
   * for opencode that spans spawning `opencode serve`, connecting, and the
   * initial session scan — so a WeChat message arriving inside that window
   * must wait instead of failing with "connected but not ready yet".
   */
  private waitForCompanionReady(): Promise<void> {
    if (this.state.pid) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        timer: setTimeout(() => {
          this.readyWaiters.delete(entry);
          reject(
            new Error(
              `${this.options.kind} companion is connected but not ready yet. Wait for it to finish starting.`,
            ),
          );
        }, 30_000),
        settle: (error?: Error) => {
          clearTimeout(entry.timer);
          this.readyWaiters.delete(entry);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        },
      };
      this.readyWaiters.add(entry);
    });
  }

  private settleReadyWaiters(error?: Error): void {
    for (const entry of [...this.readyWaiters]) {
      entry.settle(error);
    }
  }

  private async sendRequest(payload: LocalCompanionCommand): Promise<unknown> {
    let socket = this.socket;
    if (!socket) {
      throw new Error(formatCompanionNotConnectedMessage({
        kind: this.options.kind,
        launchMode: this.options.companionLaunchMode,
      }));
    }
    if (!this.state.pid && payload.command !== "dispose") {
      await this.waitForCompanionReady();
      socket = this.socket;
      if (!socket) {
        throw new Error(formatCompanionNotConnectedMessage({
          kind: this.options.kind,
          launchMode: this.options.companionLaunchMode,
        }));
      }
    }

    const id = `${++this.requestCounter}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${this.options.kind} companion request timed out after 30s (command: ${payload.command})`));
      }, 30_000);
      this.pendingRequests.set(id, {
        resolve: (value: unknown) => { clearTimeout(timer); resolve(value); },
        reject: (err: unknown) => { clearTimeout(timer); reject(err); },
      });
    });

    sendLocalCompanionMessage(socket, {
      type: "request",
      id,
      payload,
    });
    return await response;
  }
}

export function shouldStopBridgeAfterCompanionDisconnect(
  lifecycle: BridgeLifecycleMode | undefined,
): boolean {
  return lifecycle === "companion_bound";
}

export function buildCompanionHealthPatch(
  state: BridgeAdapterState,
  timestamp: string,
): {
  companionStatus: BridgeAdapterState["status"];
  companionLastStateAt: string;
  companionWorkerPid?: number;
} {
  return {
    companionStatus: state.status,
    companionLastStateAt: timestamp,
    companionWorkerPid: state.pid,
  };
}

type CompanionLaunchMode = AdapterOptions["companionLaunchMode"];

export function formatLocalCompanionStartupMessage(params: {
  kind: BridgeAdapterKind;
  launchMode?: CompanionLaunchMode;
}): string {
  if (params.launchMode === "daemon_auto") {
    return `Waiting for daemon-managed ${params.kind} companion connection. The daemon will open or reuse the visible CLI automatically.`;
  }

  return `Waiting for manual ${params.kind} companion connection. Run "${getLocalCompanionCommandName(params.kind)}" in a second terminal for this directory.`;
}

export function formatCompanionNotConnectedMessage(params: {
  kind: BridgeAdapterKind;
  launchMode?: CompanionLaunchMode;
}): string {
  if (params.launchMode === "daemon_auto") {
    return `${params.kind} companion is not connected yet. Send /${params.kind} in WeChat to open or reconnect the visible CLI automatically.`;
  }

  return `${params.kind} companion is not connected. Run "${getLocalCompanionCommandName(params.kind)}" in a second terminal for this directory.`;
}

export function isExpectedLocalCompanionClose(
  reason: LocalCompanionCloseReason | null | undefined,
): boolean {
  return typeof reason === "string" && reason.length > 0;
}

export type CompanionDisconnectDisposition =
  | {
      action: "shutdown";
      message: string;
      shutdownReason: "companion_closed";
    }
  | {
      action: "wait_for_reconnect";
      message: string;
    }
  | {
      action: "await_manual_reconnect";
      message: string;
    };

export function buildCompanionReconnectTimeoutMessage(params: {
  kind: BridgeAdapterKind;
  reconnectGraceMs: number;
}): string {
  return `${params.kind} companion did not reconnect within ${Math.ceil(params.reconnectGraceMs / 1000)}s. Stopping transient bridge bound to ${getLocalCompanionCommandName(params.kind)}.`;
}

export function getCompanionDisconnectDisposition(params: {
  kind: BridgeAdapterKind;
  lifecycle: BridgeLifecycleMode | undefined;
  expectedClose: boolean;
  reconnectGraceMs: number;
  launchMode?: CompanionLaunchMode;
}): CompanionDisconnectDisposition {
  const commandName = getLocalCompanionCommandName(params.kind);

  if (shouldStopBridgeAfterCompanionDisconnect(params.lifecycle)) {
    if (params.expectedClose) {
      return {
        action: "shutdown",
        shutdownReason: "companion_closed",
        message: `${params.kind} companion closed. Stopping transient bridge bound to ${commandName}.`,
      };
    }

    return {
      action: "wait_for_reconnect",
      message: `${params.kind} companion disconnected unexpectedly. Waiting up to ${Math.ceil(params.reconnectGraceMs / 1000)}s for ${commandName} to reconnect before stopping this transient bridge.`,
    };
  }

  if (params.expectedClose) {
    if (params.launchMode === "daemon_auto") {
      return {
        action: "await_manual_reconnect",
        message: `${params.kind} companion closed. Send /${params.kind} in WeChat to reopen the visible CLI automatically.`,
      };
    }

    return {
      action: "await_manual_reconnect",
      message: `${params.kind} companion closed. Run "${commandName}" again in a second terminal for this directory.`,
    };
  }

  if (params.launchMode === "daemon_auto") {
    return {
      action: "await_manual_reconnect",
      message: `${params.kind} companion disconnected unexpectedly. Send /${params.kind} in WeChat to reopen the visible CLI automatically.`,
    };
  }

  return {
    action: "await_manual_reconnect",
    message: `${params.kind} companion disconnected unexpectedly. Run "${commandName}" again in a second terminal for this directory to reconnect.`,
  };
}

export abstract class AbstractPtyAdapter implements BridgeAdapter {
  protected readonly options: AdapterOptions;
  protected pty: IPty | shared.PtyLike | null = null;
  protected eventSink: EventSink = () => undefined;
  protected completionTimer: ReturnType<typeof setTimeout> | null = null;
  protected state: BridgeAdapterState;
  protected hasAcceptedInput = false;
  protected shuttingDown = false;
  protected currentPreview = "(idle)";
  protected pendingApproval: ApprovalRequest | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    this.setStatus("starting", `Starting ${this.options.kind} adapter...`);

    let spawnTarget: SpawnTarget | null = null;
    try {
      const rawTarget = resolveSpawnTarget(this.options.command, this.options.kind);
      spawnTarget = unwrapCmdExeForPty(rawTarget);
      const env = this.buildEnv();
      const spawnArgs = [...spawnTarget.args, ...this.buildSpawnArgs()];

      let ptyProcess: IPty | shared.PtyLike;
      let usedFallback = false;
      try {
        ptyProcess = spawnPty(
          spawnTarget.file,
          spawnArgs,
          buildPtySpawnOptions({
            cwd: this.options.cwd,
            env,
          }),
        );
      } catch (ptyErr) {
        usedFallback = true;
        try {
          ptyProcess = spawnFallbackProcess(spawnTarget.file, spawnArgs, {
            cwd: this.options.cwd,
            env,
          });
        } catch (fallbackErr) {
          throw new Error(buildSpawnDiagnostic(ptyErr, spawnTarget), { cause: fallbackErr });
        }
      }

      this.pty = ptyProcess;
      this.shuttingDown = false;
      this.hasAcceptedInput = false;
      this.state.pid = ptyProcess.pid;
      this.state.startedAt = nowIso();
      this.state.status = "idle";
      this.state.pendingApproval = null;

      ptyProcess.onData((data) => this.handleData(data));
      ptyProcess.onExit(({ exitCode }) => this.handleExit(exitCode));

      this.afterStart();

      if (usedFallback) {
        this.emit({
          type: "stdout",
          text: t("pty.fallback.warning"),
          timestamp: nowIso(),
        });
      }

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

  async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error(`${this.options.kind} adapter is not running.`);
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.writeToPty(this.prepareInput(text));
    this.setStatus("busy");
    this.scheduleTaskComplete(this.defaultCompletionDelayMs());
  }

  async listResumeSessions(_limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    throw new Error("/resume is only supported for the codex adapter.");
  }

  async resumeSession(_sessionId: string): Promise<void> {
    throw new Error("/resume is only supported for the codex adapter.");
  }

  async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    this.scheduleTaskComplete(INTERRUPT_SETTLE_DELAY_MS);
    this.emit({
      type: "status",
      status: this.state.status,
      message: "Interrupt signal sent to the worker.",
      timestamp: nowIso(),
    });
    return true;
  }

  async reset(): Promise<void> {
    await this.dispose();
    await this.start();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    const handled = await this.applyApproval(action, this.pendingApproval);
    if (!handled) {
      return false;
    }

    this.pendingApproval = null;
    this.state.pendingApproval = null;
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
    this.clearCompletionTimer();
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (!this.pty) {
      this.state.status = "stopped";
      return;
    }

    this.shuttingDown = true;
    const pty = this.pty;
    this.pty = null;
    this.state.status = "stopped";
    this.state.pid = undefined;

    try {
      const exitPromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        pty.onExit(() => { clearTimeout(timeout); resolve(); });
      });
      pty.kill();
      await exitPromise;
    } catch {
      // Best effort shutdown.
    }
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  protected abstract buildSpawnArgs(): string[];

  protected afterStart(): void {
    // Optional hook.
  }

  protected prepareInput(text: string): string {
    return `${text.replace(/\r?\n/g, "\r")}\r`;
  }

  protected defaultCompletionDelayMs(): number {
    return 5_000;
  }

  protected async applyApproval(
    action: "confirm" | "deny",
    pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    const input =
      action === "confirm"
        ? pendingApproval.confirmInput ?? "y\r"
        : pendingApproval.denyInput ?? "n\r";
    this.setStatus("busy");
    this.writeToPty(input);
    this.scheduleTaskComplete(this.defaultCompletionDelayMs());
    return true;
  }

  protected buildEnv(): Record<string, string> {
    return buildCliEnvironment(this.options.kind);
  }

  protected emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  protected setStatus(
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

  protected scheduleTaskComplete(delayMs: number): void {
    if (!this.hasAcceptedInput || this.state.status !== "busy") {
      return;
    }

    this.clearCompletionTimer();
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      if (this.state.status !== "busy") {
        return;
      }
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
    }, delayMs);
  }

  protected clearCompletionTimer(): void {
    if (!this.completionTimer) {
      return;
    }
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  protected writeToPty(data: string): void {
    this.pty?.write(data);
  }

  protected handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    if (!this.pendingApproval) {
      const approval = detectCliApproval(text);
      if (approval) {
        this.pendingApproval = approval;
        this.state.pendingApproval = approval;
        this.setStatus("awaiting_approval", "CLI approval is required.");
        this.emit({
          type: "approval_required",
          request: approval,
          timestamp: nowIso(),
        });
        return;
      }
    }

    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });

    if (this.state.status === "busy") {
      this.scheduleTaskComplete(this.defaultCompletionDelayMs());
    }
  }

  protected handleExit(exitCode: number | undefined): void {
    this.clearCompletionTimer();
    const expectedShutdown = this.shuttingDown;
    this.shuttingDown = false;
    this.pty = null;
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

    const exitLabel =
      typeof exitCode === "number" ? `code ${exitCode}` : "an unknown code";
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} worker exited unexpectedly with ${exitLabel}.`,
      timestamp: nowIso(),
    });
  }
}

