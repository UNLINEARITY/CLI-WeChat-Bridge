import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildLocalCompanionToken } from "../companion/local-companion-link.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  buildClaudeFailureMessage,
  buildClaudeHookScript,
  buildClaudeHookSettings,
  buildClaudePermissionDecisionHookOutput,
  buildClaudePermissionApprovalRequest,
  extractClaudeAssistantMessageText,
  extractClaudeResumeConversationId,
  extractClaudeTranscriptFinalReply,
  findInjectedClaudePromptIndex,
  getClaudePermissionAutoResponse,
  getClaudeWechatOutboundAttachmentDenyMessage,
  normalizeClaudeAssistantMessage,
  parseClaudeHookPayload,
  type ClaudeHookPayload,
  type PendingInjectedClaudePrompt,
} from "./claude-hooks.ts";
import type {
  ApprovalRequest,
  BridgeNoticeLevel,
  BridgeResumeSessionCandidate,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";
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
  private readonly pendingHookApprovals = new Map<string, ClaudePendingHookApproval>();
  private recoveringInvalidResume = false;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private workingNoticeDelayMs = CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS;
  private lastCompactCompletionAtMs = 0;

  constructor(options: AdapterOptions) {
    super(options);
    this.runtimeSessionId = options.initialSharedSessionId ?? options.initialSharedThreadId ?? null;
    this.resumeConversationId = options.initialResumeConversationId ?? null;
    this.transcriptPath = options.initialTranscriptPath ?? null;
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

    await this.startHookServer();
    try {
      await super.start();
    } catch (error) {
      await this.stopHookServer();
      throw error;
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error("claude adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("claude is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingApproval) {
      throw new Error("A Claude approval request is pending. Reply with /confirm <code> or /deny.");
    }

    const normalizedText = normalizeOutput(text).trim();
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
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy");
    this.writeToPty(this.buildRemoteInputPayload(text));
    await delay(CLAUDE_REMOTE_ENTER_DELAY_MS);
    this.writeToPty("\r");
    this.armWechatWorkingNotice();
  }

  override async listResumeSessions(_limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    throw new Error(
      'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
    );
  }

  override async resumeSession(_threadId: string): Promise<void> {
    throw new Error(
      'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
    );
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.writeToPty("\u0003");
    return true;
  }

  override async reset(): Promise<void> {
    this.clearWechatWorkingNotice(true);
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
    await super.reset();
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (this.pendingApproval.requestId) {
      const handled = this.respondToClaudeHookApproval(this.pendingApproval.requestId, action);
      if (handled) {
        this.clearWechatWorkingNotice();
        this.pendingCliApprovalHints = null;
        this.pendingApproval = null;
        this.state.pendingApproval = null;
        this.state.pendingApprovalOrigin = undefined;
        this.setStatus("busy");
        return true;
      }
    }

    const input =
      action === "confirm" ? this.pendingApproval.confirmInput : this.pendingApproval.denyInput;
    if (!input) {
      throw new Error(
        "Remote approval is not safely available for this Claude prompt. Approve it in the local Claude terminal.",
      );
    }

    this.clearWechatWorkingNotice();
    this.pendingCliApprovalHints = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("busy");
    this.writeToPty(input);
    return true;
  }

  override async dispose(): Promise<void> {
    this.detachLocalTerminal();
    this.clearWechatWorkingNotice(true);
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
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
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
      this.clearWechatWorkingNotice();
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

  protected override handleExit(exitCode: number | undefined): void {
    this.detachLocalTerminal();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
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
          for (const [requestId, pending] of this.pendingHookApprovals.entries()) {
            if (pending.socket === socket) {
              this.pendingHookApprovals.delete(requestId);
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
    const runtimeDir = path.join(workspaceDir, "claude-runtime");
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

    fs.writeFileSync(
      hookScriptPath,
      buildClaudeHookScript({
        platform: process.platform,
        runtimeExecPath: process.execPath,
        hookEntryPath,
        hookPort: this.hookPort,
        hookToken: this.hookToken,
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
    if (!this.pty || !process.stdout.isTTY) {
      return;
    }

    try {
      this.pty.resize(process.stdout.columns || DEFAULT_COLS, process.stdout.rows || DEFAULT_ROWS);
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

  private armWechatWorkingNotice(): void {
    this.clearWechatWorkingNotice();
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

  private clearWechatWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
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
    this.clearWechatWorkingNotice(true);
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
    this.clearWechatWorkingNotice(true);
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
      case "UserPromptSubmit":
        this.handleClaudeUserPromptSubmit(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PermissionRequest":
        this.handleClaudePermissionRequest(params.requestId, payload, params.socket);
        return;
      case "Notification":
        if (payload.notification_type === "permission_prompt" && this.pendingApproval) {
          this.setStatus("awaiting_approval", "Claude approval is required.");
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

    if (previousRuntimeSessionId === payload.session_id) {
      return;
    }

    const timestamp = nowIso();
    const isRestore =
      !previousRuntimeSessionId &&
      (payload.source === "resume" ||
        (nextResumeConversationId !== null &&
          nextResumeConversationId === previousResumeConversationId));
    const source: BridgeThreadSwitchSource = isRestore ? "restore" : "local";
    const reason: BridgeThreadSwitchReason = isRestore ? "startup_restore" : "local_follow";
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
  }

  private handleClaudeUserPromptSubmit(payload: { prompt?: string }): void {
    const prompt =
      typeof payload.prompt === "string" ? normalizeOutput(payload.prompt).trim() : "";
    if (!prompt) {
      return;
    }

    const injectedIndex = findInjectedClaudePromptIndex(prompt, this.pendingInjectedInputs);
    if (injectedIndex >= 0) {
      this.pendingInjectedInputs.splice(injectedIndex, 1);
      return;
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(prompt);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "local";
    this.pendingCliApprovalHints = null;
    this.clearWechatWorkingNotice(true);
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
    this.clearWechatWorkingNotice(true);
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
      await super.reset();
    } finally {
      this.recoveringInvalidResume = false;
    }
  }

  private handleClaudePermissionRequest(
    requestId: string,
    payload: ClaudeHookPayload,
    socket: net.Socket,
  ): void {
    this.clearWechatWorkingNotice();
    const denyMessage = getClaudeWechatOutboundAttachmentDenyMessage(payload);
    if (denyMessage) {
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      if (this.state.status === "awaiting_approval") {
        this.setStatus("busy");
      }
      this.respondToClaudeHook(
        socket,
        requestId,
        buildClaudePermissionDecisionHookOutput("deny", denyMessage),
      );
      return;
    }

    const autoResponse = getClaudePermissionAutoResponse(payload);
    if (autoResponse) {
      if (!this.pendingApproval && !this.state.pendingApproval) {
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
      return;
    }

    this.flushPendingClaudeHookApprovals();
    this.pendingHookApprovals.set(requestId, {
      requestId,
      socket,
    });
    const request = buildClaudePermissionApprovalRequest(payload);
    this.pendingApproval = {
      ...request,
      requestId,
      confirmInput:
        this.pendingApproval?.confirmInput ?? this.pendingCliApprovalHints?.confirmInput,
      denyInput: this.pendingApproval?.denyInput ?? this.pendingCliApprovalHints?.denyInput,
    };
    this.pendingCliApprovalHints = null;
    this.state.pendingApproval = this.pendingApproval;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "Claude approval is required.");
    this.emit({
      type: "approval_required",
      request: this.pendingApproval,
      timestamp: nowIso(),
    });
  }

  private handleClosedClaudeHookApproval(requestId: string): void {
    if (this.pendingApproval?.requestId !== requestId) {
      return;
    }

    if (this.pendingApproval.confirmInput || this.pendingApproval.denyInput) {
      this.pendingApproval = {
        ...this.pendingApproval,
        requestId: undefined,
      };
      this.state.pendingApproval = this.pendingApproval;
      return;
    }

    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    if (this.state.status === "awaiting_approval") {
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

  private handleClaudeStop(payload: { last_assistant_message?: string }): void {
    this.clearWechatWorkingNotice(true);
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
    error?: string;
    error_details?: string;
    last_assistant_message?: string;
  }): void {
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

  private respondToClaudeHookApproval(
    requestId: string,
    action: "confirm" | "deny",
  ): boolean {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return false;
    }

    this.pendingHookApprovals.delete(requestId);
    this.respondToClaudeHook(
      pending.socket,
      requestId,
      buildClaudePermissionDecisionHookOutput(action),
    );
    return true;
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
    for (const requestId of Array.from(this.pendingHookApprovals.keys())) {
      this.cancelPendingClaudeHookApproval(requestId);
    }
  }
}

