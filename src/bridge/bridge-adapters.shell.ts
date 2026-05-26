import type { ApprovalRequest } from "./bridge-types.ts";
import {
  getInteractiveShellCommandRejectionMessage,
  isHighRiskShellCommand,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import * as shared from "./bridge-adapters.shared.ts";

type ShellRuntime = shared.ShellRuntime;

const {
  buildShellInputPayload,
  buildShellProfileCommand,
  resolveShellRuntime,
} = shared;

export class ShellCommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellCommandRejectedError";
  }
}

export class ShellAdapter extends AbstractPtyAdapter {
  private static readonly COMPLETION_MARKER_PREFIX = "__WECHAT_BRIDGE_DONE__";
  private static readonly POWERSHELL_LEADING_NOISE_PATTERNS = [
    /^PS>>\s*/u,
    /^PS [^>\n]*>\s*/u,
    /^PS>\s*/u,
    /^>>\s*/u,
    /^>\s*/u,
    /^function global:prompt \{ "" \}/u,
    /^\$__wechatBridgePreviousErrorActionPreference = \$ErrorActionPreference/u,
    /^\$ErrorActionPreference = 'Continue'/u,
    /^\$global:LASTEXITCODE = 0/u,
    /^try \{/u,
    /^\$decoded = \[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\(".*"\)\)/u,
    /^\$scriptBlock = \[scriptblock\]::Create\(\$decoded\)/u,
    /^& \$scriptBlock/u,
    /^\} catch \{/u,
    /^Write-Error \$_/u,
    /^\$global:LASTEXITCODE = 1/u,
    /^\} finally \{/u,
    /^if \(-not \(\$global:LASTEXITCODE -is \[int\]\)\) \{ \$global:LASTEXITCODE = 0 \}/u,
    /^Write-Output "__WECHAT_BRIDGE_DONE__:[^"]*"/u,
    /^\$ErrorActionPreference = \$__wechatBridgePreviousErrorActionPreference/u,
    /^\}/u,
  ] as const;

  private pendingShellCommand: string | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private outputBuffer = "";
  private currentCompletionMarker: string | null = null;
  private expectedEchoLines: string[] = [];
  private commandSequence = 0;

  protected buildSpawnArgs(): string[] {
    return this.getShellRuntime().launchArgs;
  }

  protected override buildEnv(): Record<string, string> {
    const env = super.buildEnv();
    if (this.getShellRuntime().family === "posix") {
      env.PS1 = "";
      env.PROMPT = "";
      env.RPROMPT = "";
    }
    return env;
  }

  protected override afterStart(): void {
    if (this.options.profile) {
      this.writeToPty(
        `${buildShellProfileCommand(this.options.profile, this.getShellRuntime().family)}\r`,
      );
    }

    if (this.getShellRuntime().family === "powershell") {
      this.writeToPty('function global:prompt { "" }\r');
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error("shell adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("shell is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingApproval || this.state.status === "awaiting_approval") {
      throw new Error("A shell approval request is pending. Reply with /confirm or /deny.");
    }

    const rejectionMessage = getInteractiveShellCommandRejectionMessage(text);
    if (rejectionMessage) {
      throw new ShellCommandRejectedError(rejectionMessage);
    }

    if (isHighRiskShellCommand(text)) {
      this.pendingShellCommand = text;
      const request: ApprovalRequest = {
        source: "shell",
        summary: "High-risk shell command detected. Confirmation is required.",
        commandPreview: truncatePreview(text, 180),
      };
      this.pendingApproval = request;
      this.state.pendingApproval = request;
      this.state.pendingApprovalOrigin = "wechat";
      this.setStatus("awaiting_approval", "Waiting for shell command approval.");
      this.emit({
        type: "approval_required",
        request,
        timestamp: nowIso(),
      });
      return;
    }

    this.startShellCommand(text);
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    this.clearInterruptTimer();
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
        this.finishShellCommand({
          summary: "Interrupted",
          statusMessage: "Shell command interrupted.",
        });
      }
    }, 1_500);
    return true;
  }

  protected override async applyApproval(
    action: "confirm" | "deny",
    _pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (action === "deny") {
      this.pendingShellCommand = null;
      this.finishShellCommand({
        summary: "Denied",
        statusMessage: "Shell command denied.",
      });
      return true;
    }

    const command = this.pendingShellCommand;
    if (!command) {
      return false;
    }

    this.pendingShellCommand = null;
    this.startShellCommand(command);
    return true;
  }

  protected override handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    this.outputBuffer = `${this.outputBuffer}${text}`;
    this.flushShellOutputBuffer();
  }

  protected override handleExit(exitCode: number | undefined): void {
    if (this.hasAcceptedInput) {
      this.flushShellOutputBuffer(true);
    }
    this.resetShellCommandState();
    super.handleExit(exitCode);
  }

  private getShellRuntime(): ShellRuntime {
    return resolveShellRuntime(this.options.command);
  }

  private startShellCommand(text: string): void {
    if (!this.pty) {
      throw new Error(`${this.options.kind} adapter is not running.`);
    }

    this.clearInterruptTimer();
    this.resetShellCommandState({
      preserveStatus: true,
      preservePreview: true,
    });

    const completionMarker = this.createCompletionMarker();
    const payload = buildShellInputPayload(
      text,
      this.getShellRuntime().family,
      completionMarker,
    );

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.currentCompletionMarker = completionMarker;
    this.expectedEchoLines = normalizeOutput(payload)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    this.writeToPty(payload);
    this.setStatus("busy");
  }

  private flushShellOutputBuffer(force = false): void {
    const lastNewlineIndex = this.outputBuffer.lastIndexOf("\n");
    if (!force && lastNewlineIndex < 0) {
      return;
    }

    const sliceEnd = force
      ? this.outputBuffer.length
      : Math.max(0, lastNewlineIndex + 1);
    if (sliceEnd === 0) {
      return;
    }

    const chunk = this.outputBuffer.slice(0, sliceEnd);
    this.outputBuffer = this.outputBuffer.slice(sliceEnd);

    const visibleLines: string[] = [];
    let completedExitCode: number | null = null;

    for (const rawLine of chunk.split("\n")) {
      if (!rawLine && !force) {
        continue;
      }

      const completionExitCode = this.parseCompletionExitCode(rawLine);
      if (completionExitCode !== null) {
        completedExitCode = completionExitCode;
        continue;
      }

      const filtered = this.filterShellOutputLine(rawLine);
      if (filtered) {
        visibleLines.push(filtered);
      }
    }

    const visibleText = visibleLines.join("\n").trim();
    if (visibleText) {
      this.emit({
        type: "stdout",
        text: visibleText,
        timestamp: nowIso(),
      });
    }

    if (completedExitCode !== null) {
      this.finishShellCommand({ exitCode: completedExitCode });
    }
  }

  private filterShellOutputLine(line: string): string | null {
    const cleanedLine =
      this.getShellRuntime().family === "powershell"
        ? this.stripLeadingPowerShellNoise(line)
        : line;
    const trimmed = cleanedLine.trim();
    if (!trimmed) {
      return null;
    }

    if (this.consumeExpectedEchoLine(trimmed)) {
      return null;
    }

    if (this.isShellPromptLine(trimmed)) {
      return null;
    }

    if (this.getShellRuntime().family === "posix") {
      if (
        trimmed === "__wechat_bridge_status=$?" ||
        trimmed.startsWith("printf '%s:%s\\n'") ||
        trimmed.startsWith("printf '__WECHAT_BRIDGE_DONE__:%s")
      ) {
        return null;
      }
    }

    return cleanedLine;
  }

  private consumeExpectedEchoLine(line: string): boolean {
    if (!this.expectedEchoLines.length) {
      return false;
    }

    const normalizedLine = this.normalizeEchoLine(line);
    if (normalizedLine !== this.expectedEchoLines[0]) {
      return false;
    }

    this.expectedEchoLines.shift();
    return true;
  }

  private normalizeEchoLine(line: string): string {
    const trimmed = line.trim();
    if (this.getShellRuntime().family === "powershell") {
      return trimmed.replace(/^(?:PS [^>]*>\s*|PS>\s*|>>\s*|>\s*)+/u, "").trim();
    }
    return trimmed.replace(/^(?:[$#>]\s*)+/u, "").trim();
  }

  private isShellPromptLine(line: string): boolean {
    if (this.getShellRuntime().family === "powershell") {
      return /^(?:PS [^>]*>\s*|PS>\s*|>>\s*|>\s*)+$/u.test(line);
    }
    return /^(?:[$#>]\s*)+$/u.test(line);
  }

  private parseCompletionExitCode(line: string): number | null {
    const marker = this.currentCompletionMarker;
    if (!marker) {
      return null;
    }

    const trimmed = this.stripLeadingShellPromptTokens(line).trim();
    const prefix = `${marker}:`;
    if (!trimmed.startsWith(prefix)) {
      return null;
    }

    const exitCodeText = trimmed.slice(prefix.length).trim();
    if (!/^-?\d+$/u.test(exitCodeText)) {
      return null;
    }

    return Number(exitCodeText);
  }

  private finishShellCommand(options: {
    exitCode?: number;
    summary?: string;
    statusMessage?: string;
  }): void {
    const summary = options.summary ?? this.currentPreview;
    this.resetShellCommandState();
    this.setStatus("idle", options.statusMessage);
    this.emit({
      type: "task_complete",
      exitCode: options.exitCode,
      summary,
      timestamp: nowIso(),
    });
  }

  private resetShellCommandState(
    options: {
      preserveStatus?: boolean;
      preservePreview?: boolean;
    } = {},
  ): void {
    this.clearInterruptTimer();
    this.clearCompletionTimer();
    this.pendingApproval = null;
    this.pendingShellCommand = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.outputBuffer = "";
    this.currentCompletionMarker = null;
    this.expectedEchoLines = [];
    if (!options.preservePreview) {
      this.currentPreview = "(idle)";
    }
    if (!options.preserveStatus && this.state.status !== "stopped") {
      this.state.status = "idle";
    }
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimer) {
      return;
    }
    clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }

  private createCompletionMarker(): string {
    this.commandSequence += 1;
    return `${ShellAdapter.COMPLETION_MARKER_PREFIX}:${this.commandSequence.toString(36)}`;
  }

  private stripLeadingPowerShellNoise(line: string): string {
    let text = line.trimStart();

    while (text) {
      let stripped = false;
      for (const pattern of ShellAdapter.POWERSHELL_LEADING_NOISE_PATTERNS) {
        const next = text.replace(pattern, "");
        if (next !== text) {
          text = next.trimStart();
          stripped = true;
          break;
        }
      }
      if (!stripped) {
        break;
      }
    }

    return text;
  }

  private stripLeadingShellPromptTokens(line: string): string {
    let text = line.trimStart();
    if (this.getShellRuntime().family === "powershell") {
      while (true) {
        const next = text
          .replace(/^PS>>\s*/u, "")
          .replace(/^PS [^>\n]*>\s*/u, "")
          .replace(/^PS>\s*/u, "")
          .replace(/^>>\s*/u, "")
          .replace(/^>\s*/u, "");
        if (next === text) {
          break;
        }
        text = next.trimStart();
      }
      return text;
    }

    return text.replace(/^(?:[$#>]\s*)+/u, "").trimStart();
  }
}
