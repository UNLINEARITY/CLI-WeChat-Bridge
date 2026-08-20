import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeTurnOrigin,
} from "./bridge-types.ts";
import {
  assertNoReservedExtraCliArgs,
  buildCliEnvironment,
  describeUnknownError,
  isRecord,
  resolveSpawnTarget,
  type AdapterOptions,
  type EventSink,
} from "./bridge-adapters.shared.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import { normalizeOutput, nowIso } from "./bridge-utils.ts";

const PI_TUI_CONNECT_WARNING_MS = 30_000;
const PI_TUI_REQUEST_TIMEOUT_MS = 30_000;
const PI_TUI_RECONNECT_TIMEOUT_MS = 10_000;
const PI_TUI_MAX_BUFFER_SIZE = 8 * 1024 * 1024;

type PiTuiFrame = Record<string, unknown>;

type PiTuiPendingRequest = {
  command: string;
  resolve: (value: PiTuiFrame) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PiSessionFileSummary = BridgeResumeSessionCandidate & {
  filePath: string;
};

type PiTuiAdapterDeps = {
  spawnProcess?: typeof spawn;
  killProcessTree?: (pid: number) => void;
  createServer?: typeof net.createServer;
};

function expandHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function buildPiSessionDirectory(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const customSessionDir = env.PI_CODING_AGENT_SESSION_DIR;
  if (customSessionDir) {
    return path.resolve(expandHomePath(customSessionDir));
  }

  const agentDir = env.PI_CODING_AGENT_DIR
    ? path.resolve(expandHomePath(env.PI_CODING_AGENT_DIR))
    : path.join(os.homedir(), ".pi", "agent");
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safePath);
}

function extractMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return normalizeOutput(content).trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return normalizeOutput(
    content
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n"),
  ).trim();
}

function summarizePiSessionFile(filePath: string, cwd: string): PiSessionFileSummary | null {
  try {
    const entries = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => isRecord(entry));
    const header = entries.find((entry) => entry.type === "session");
    if (!header || typeof header.id !== "string") {
      return null;
    }
    if (typeof header.cwd === "string" && path.resolve(header.cwd) !== path.resolve(cwd)) {
      return null;
    }

    let sessionName = "";
    let firstUserMessage = "";
    for (const entry of entries) {
      if (entry.type === "session_info" && typeof entry.name === "string") {
        sessionName = normalizeOutput(entry.name).trim();
      }
      if (firstUserMessage || entry.type !== "message" || !isRecord(entry.message)) {
        continue;
      }
      if (entry.message.role === "user") {
        firstUserMessage = extractMessageText(entry.message);
      }
    }

    return {
      sessionId: header.id,
      title: sessionName || firstUserMessage || header.id,
      lastUpdatedAt: fs.statSync(filePath).mtime.toISOString(),
      source: "pi",
      filePath,
    };
  } catch {
    return null;
  }
}

export function listPiResumeSessions(
  cwd: string,
  limit = 10,
  env: Record<string, string | undefined> = process.env,
): BridgeResumeSessionCandidate[] {
  const sessionDir = buildPiSessionDirectory(cwd, env);
  if (!fs.existsSync(sessionDir)) {
    return [];
  }

  return fs
    .readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDir, entry.name))
    .map((filePath) => summarizePiSessionFile(filePath, cwd))
    .filter((entry): entry is PiSessionFileSummary => entry !== null)
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit))
    .map(({ filePath: _filePath, ...candidate }) => candidate);
}

function findPiSessionFile(
  cwd: string,
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const sessionDir = buildPiSessionDirectory(cwd, env);
  if (!fs.existsSync(sessionDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(sessionDir, entry.name);
    if (summarizePiSessionFile(filePath, cwd)?.sessionId === sessionId) {
      return filePath;
    }
  }
  return null;
}

export function buildPiTuiCliArgs(options: {
  extensionPath: string;
  sessionStartMode?: "restore" | "new";
  initialSessionId?: string;
  extraCliArgs?: string[];
}): string[] {
  const extraCliArgs = options.extraCliArgs ?? [];
  assertNoReservedExtraCliArgs(
    extraCliArgs,
    [
      "--mode",
      "--print",
      "-p",
      "--approve",
      "-a",
      "--no-approve",
      "-na",
      "--continue",
      "-c",
      "--resume",
      "-r",
      "--session",
      "--session-id",
      "--session-dir",
      "--no-session",
    ],
    "Pi TUI runtime",
  );

  const args = ["--approve", "--extension", options.extensionPath];
  if (options.sessionStartMode !== "new") {
    if (options.initialSessionId) {
      args.push("--session-id", options.initialSessionId);
    } else {
      args.push("--continue");
    }
  }
  return [...args, ...extraCliArgs];
}

export function attachPiTuiJsonlReader(
  stream: NodeJS.ReadableStream,
  onFrame: (frame: PiTuiFrame) => void,
  onError: (error: Error) => void,
): () => void {
  let buffer = "";
  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buffer.length > PI_TUI_MAX_BUFFER_SIZE) {
      buffer = "";
      onError(new Error("Pi TUI bridge buffer exceeded 8MB without a complete LF frame."));
      return;
    }
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) {
          onFrame(parsed);
        }
      } catch (error) {
        onError(new Error(`Invalid Pi TUI bridge frame: ${describeUnknownError(error)}`));
      }
    }
  };
  stream.on("data", onData);
  return () => stream.removeListener("data", onData);
}

function getPiBridgeExtensionPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return path.resolve(
    path.dirname(modulePath),
    "..",
    "companion",
    `pi-tui-bridge-extension${path.extname(modulePath)}`,
  );
}

export class PiTuiAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly deps: Required<PiTuiAdapterDeps>;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;
  private child: ChildProcess | null = null;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private readonly socketReaders = new Map<net.Socket, () => void>();
  private readonly retiringSockets = new Set<net.Socket>();
  private connectWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;
  private readonly pendingRequests = new Map<string, PiTuiPendingRequest>();
  private extensionReady = false;
  private disposing = false;
  private authenticated = new WeakSet<net.Socket>();
  private currentAssistantText = "";
  private currentTurnError = "";
  private finalizingTurn = false;
  private pendingSessionSwitch:
    | { source: BridgeSessionSwitchSource; reason: BridgeSessionSwitchReason }
    | null = null;
  private readonly token = crypto.randomBytes(32).toString("hex");

  constructor(options: AdapterOptions, deps: PiTuiAdapterDeps = {}) {
    this.options = options;
    this.deps = {
      spawnProcess: deps.spawnProcess ?? spawn,
      killProcessTree: deps.killProcessTree ?? killProcessTreeSync,
      createServer: deps.createServer ?? net.createServer,
    };
    this.state = {
      kind: "pi",
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
      sharedSessionId:
        options.sessionStartMode === "new" ? undefined : options.initialSharedSessionId,
      activeRuntimeSessionId:
        options.sessionStartMode === "new" ? undefined : options.initialSharedSessionId,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    this.disposing = false;
    this.extensionReady = false;
    this.setStatus("starting", "Starting the native Pi TUI...");
    const port = await this.startServer();
    const extensionPath = getPiBridgeExtensionPath();
    if (!fs.existsSync(extensionPath)) {
      await this.dispose();
      throw new Error(`Pi TUI bridge extension is missing: ${extensionPath}`);
    }
    const cliArgs = buildPiTuiCliArgs({
      extensionPath,
      sessionStartMode: this.options.sessionStartMode,
      initialSessionId: this.options.initialSharedSessionId,
      extraCliArgs: this.options.extraCliArgs,
    });
    const target = resolveSpawnTarget(this.options.command, "pi", {
      forwardArgs: cliArgs,
    });
    const env = {
      ...buildCliEnvironment("pi"),
      CLI_BRIDGE_PI_TUI_PORT: String(port),
      CLI_BRIDGE_PI_TUI_TOKEN: this.token,
    };
    const child = this.deps.spawnProcess(target.file, target.args, {
      cwd: this.options.cwd,
      env,
      stdio: "inherit",
      windowsHide: false,
      shell: false,
    });
    this.child = child;
    this.state.pid = child.pid;
    this.state.startedAt = nowIso();
    child.once("error", (error) => {
      this.clearConnectWarningTimer();
      this.rejectPendingRequests(error);
      if (!this.disposing) {
        this.emit({
          type: "fatal_error",
          message: `Failed to start Pi TUI: ${describeUnknownError(error)}`,
          timestamp: nowIso(),
        });
      }
    });
    child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    this.scheduleConnectWarning();
  }

  async sendInput(text: string): Promise<void> {
    this.assertConnected();
    const prompt = text.trim();
    if (!prompt) {
      return;
    }
    if (this.state.status === "busy") {
      throw new Error("Pi is still working. Wait for the current reply or use /stop.");
    }
    this.beginTurn("wechat");
    try {
      await this.sendCommand("prompt", { text: prompt });
    } catch (error) {
      this.clearActiveTurn();
      this.setStatus("idle");
      throw error;
    }
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    return listPiResumeSessions(this.options.cwd, limit);
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.assertConnected();
    if (this.state.status === "busy") {
      throw new Error("Pi is still working. Stop the current turn before switching sessions.");
    }
    const sessionPath = findPiSessionFile(this.options.cwd, sessionId);
    if (!sessionPath) {
      throw new Error(`Pi session not found for this workspace: ${sessionId}`);
    }
    this.pendingSessionSwitch = { source: "wechat", reason: "wechat_resume" };
    try {
      const response = await this.sendCommand("switch_session", { sessionPath });
      this.applySessionState(response.data, "wechat", "wechat_resume", true);
      if (isRecord(response.data) && response.data.cancelled === true) {
        throw new Error("Pi session switch was cancelled by an extension.");
      }
    } finally {
      this.pendingSessionSwitch = null;
    }
  }

  async createSession(): Promise<void> {
    this.assertConnected();
    if (this.state.status === "busy") {
      throw new Error("Pi is still working. Stop the current turn before creating a session.");
    }
    this.pendingSessionSwitch = { source: "wechat", reason: "wechat_resume" };
    try {
      const response = await this.sendCommand("new_session");
      this.applySessionState(response.data, "wechat", "wechat_resume", true);
      if (isRecord(response.data) && response.data.cancelled === true) {
        throw new Error("Pi session creation was cancelled by an extension.");
      }
    } finally {
      this.pendingSessionSwitch = null;
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.socket || this.state.status !== "busy") {
      return false;
    }
    await this.sendCommand("abort");
    return true;
  }

  async reset(): Promise<void> {
    await this.createSession();
  }

  async resolveApproval(_action: "confirm" | "deny"): Promise<boolean> {
    return false;
  }

  async resolveAllApprovals(_action: "confirm" | "deny"): Promise<number> {
    return 0;
  }

  async submitUserInput(_answers: Record<string, string[]>): Promise<boolean> {
    return false;
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.clearConnectWarningTimer();
    this.clearReconnectTimer();
    this.rejectPendingRequests(new Error("Pi TUI adapter is shutting down."));
    for (const [socket, detach] of this.socketReaders) {
      detach();
      socket.destroy();
    }
    this.socketReaders.clear();
    this.retiringSockets.clear();
    this.socket = null;
    if (this.server) {
      const server = this.server;
      this.server = null;
      if (server.listening) {
        await new Promise<void>((resolve) => {
          try {
            server.close(() => resolve());
          } catch {
            resolve();
          }
        });
      }
    }
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      try {
        this.deps.killProcessTree(child.pid);
      } catch {
        // Best effort.
      }
    }
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.extensionReady = false;
    this.clearActiveTurn();
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private async startServer(): Promise<number> {
    const server = this.deps.createServer((socket) => this.acceptSocket(socket));
    this.server = server;
    return await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Pi TUI bridge server did not expose a TCP port."));
          return;
        }
        resolve(address.port);
      });
    });
  }

  private acceptSocket(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    const detach = attachPiTuiJsonlReader(
      socket,
      (frame) => {
        if (!this.authenticated.has(socket)) {
          if (frame.type !== "hello" || frame.token !== this.token) {
            socket.destroy();
            return;
          }
          this.authenticated.add(socket);
          this.clearReconnectTimer();
          const previousSocket = this.socket;
          this.socket = socket;
          this.extensionReady = true;
          this.clearConnectWarningTimer();
          if (this.state.status === "starting") {
            this.setStatus("idle", "Native Pi TUI connected with full local permissions.");
          }
          if (previousSocket && previousSocket !== socket) {
            if (this.hasPendingSessionCommand()) {
              this.retiringSockets.add(previousSocket);
            } else {
              previousSocket.destroy();
            }
          }
          return;
        }
        this.handleFrame(frame, socket);
      },
      (error) => this.handleProtocolError(error),
    );
    socket.once("close", () => {
      detach();
      this.socketReaders.delete(socket);
      this.retiringSockets.delete(socket);
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleReconnectFailure();
      }
    });
    socket.once("error", () => {
      // Close handling owns reconnect behavior.
    });
    this.socketReaders.set(socket, detach);
  }

  private handleFrame(frame: PiTuiFrame, sourceSocket: net.Socket): void {
    if (frame.type === "response") {
      this.handleResponse(frame);
      if (this.retiringSockets.has(sourceSocket) && !this.hasPendingSessionCommand()) {
        sourceSocket.destroy();
      }
      return;
    }
    switch (frame.type) {
      case "session_state": {
        const pending = this.pendingSessionSwitch;
        this.applySessionState(
          frame,
          pending?.source ?? "local",
          pending?.reason ?? "local_follow",
          Boolean(this.state.sharedSessionId),
        );
        this.setStatus(this.state.status);
        break;
      }
      case "local_input":
        if (typeof frame.text === "string" && frame.text.trim()) {
          this.handleLocalInput(frame.text.trim());
        }
        break;
      case "agent_start":
        if (!this.state.activeTurnOrigin) {
          this.beginTurn("local");
        }
        break;
      case "assistant_message":
        if (typeof frame.text === "string") {
          this.currentAssistantText = normalizeOutput(frame.text).trim();
        }
        if (frame.stopReason === "error") {
          this.currentTurnError =
            typeof frame.errorMessage === "string"
              ? frame.errorMessage
              : "Pi stopped because the model returned an error.";
        }
        break;
      case "agent_settled":
        void this.finalizeTurn();
        break;
    }
  }

  private handleLocalInput(text: string): void {
    this.emit({
      type: "mirrored_user_input",
      text,
      origin: "local",
      timestamp: nowIso(),
    });
  }

  private beginTurn(origin: BridgeTurnOrigin): void {
    this.currentAssistantText = "";
    this.currentTurnError = "";
    this.state.activeTurnId = `${Date.now()}-${++this.requestCounter}`;
    this.state.activeTurnOrigin = origin;
    this.state.lastInputAt = nowIso();
    this.setStatus("busy", origin === "wechat" ? "Pi TUI is handling a WeChat request." : "Pi TUI is working.");
  }

  private async finalizeTurn(): Promise<void> {
    if (this.finalizingTurn || !this.state.activeTurnOrigin) {
      return;
    }
    this.finalizingTurn = true;
    const origin = this.state.activeTurnOrigin;
    try {
      if (this.currentTurnError) {
        if (origin === "wechat") {
          this.emit({ type: "task_failed", message: this.currentTurnError, timestamp: nowIso() });
        }
      } else if (origin === "wechat" && this.currentAssistantText) {
        this.emit({ type: "final_reply", text: this.currentAssistantText, timestamp: nowIso() });
      }
      this.state.lastOutputAt = nowIso();
      this.clearActiveTurn();
      this.setStatus("idle");
    } finally {
      this.finalizingTurn = false;
    }
  }

  private applySessionState(
    value: unknown,
    source: BridgeSessionSwitchSource,
    reason: BridgeSessionSwitchReason,
    emitSwitch: boolean,
  ): void {
    if (!isRecord(value) || typeof value.sessionId !== "string") {
      return;
    }
    const previousSessionId = this.state.sharedSessionId;
    this.state.sharedSessionId = value.sessionId;
    this.state.activeRuntimeSessionId = value.sessionId;
    this.state.transcriptPath =
      typeof value.sessionFile === "string" ? value.sessionFile : undefined;
    if (emitSwitch && value.sessionId !== previousSessionId) {
      this.emit({
        type: "session_switched",
        sessionId: value.sessionId,
        source,
        reason,
        timestamp: nowIso(),
      });
    }
  }

  private sendCommand(command: string, payload: Record<string, unknown> = {}): Promise<PiTuiFrame> {
    this.assertConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("Native Pi TUI is not connected to the WeChat bridge."));
    }
    const id = `pi-tui-${++this.requestCounter}`;
    return new Promise<PiTuiFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for Pi TUI command: ${command}`));
      }, PI_TUI_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { command, resolve, reject, timer });
      try {
        socket.write(`${JSON.stringify({ id, type: command, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private handleResponse(frame: PiTuiFrame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (frame.success === false) {
      pending.reject(
        new Error(
          typeof frame.error === "string"
            ? frame.error
            : `Pi TUI command failed: ${pending.command}`,
        ),
      );
      return;
    }
    pending.resolve(frame);
  }

  private hasPendingSessionCommand(): boolean {
    return [...this.pendingRequests.values()].some(
      (pending) => pending.command === "new_session" || pending.command === "switch_session",
    );
  }

  private assertConnected(): void {
    if (!this.child || !this.socket || this.socket.destroyed) {
      throw new Error("Native Pi TUI is not connected to the WeChat bridge.");
    }
  }

  private clearActiveTurn(): void {
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
  }

  private rejectPendingRequests(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private scheduleReconnectFailure(): void {
    this.clearReconnectTimer();
    if (this.disposing || !this.child) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.socket && !this.disposing) {
        this.emit({
          type: "fatal_error",
          message: "The native Pi TUI bridge extension disconnected and did not reconnect.",
          timestamp: nowIso(),
        });
      }
    }, PI_TUI_RECONNECT_TIMEOUT_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleConnectWarning(): void {
    this.clearConnectWarningTimer();
    this.connectWarningTimer = setTimeout(() => {
      this.connectWarningTimer = null;
      if (!this.extensionReady && !this.disposing && this.child) {
        this.setStatus(
          "starting",
          "Native Pi TUI is still loading; waiting for the bridge extension to connect.",
        );
      }
    }, PI_TUI_CONNECT_WARNING_MS);
    this.connectWarningTimer.unref?.();
  }

  private clearConnectWarningTimer(): void {
    if (this.connectWarningTimer) {
      clearTimeout(this.connectWarningTimer);
      this.connectWarningTimer = null;
    }
  }

  private handleProtocolError(error: Error): void {
    if (!this.disposing) {
      this.emit({ type: "fatal_error", message: error.message, timestamp: nowIso() });
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearConnectWarningTimer();
    this.rejectPendingRequests(
      new Error(`Pi TUI exited (code=${code ?? "none"}, signal=${signal ?? "none"}).`),
    );
    this.child = null;
    this.state.pid = undefined;
    this.state.status = "stopped";
    this.extensionReady = false;
    this.clearActiveTurn();
    if (!this.disposing) {
      this.emit({
        type: "status",
        status: "stopped",
        timestamp: nowIso(),
      });
    }
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({ type: "status", status, message, timestamp: nowIso() });
  }

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }
}
