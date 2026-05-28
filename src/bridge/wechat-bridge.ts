#!/usr/bin/env bun

import path from "node:path";

import {
  resolveDefaultAdapterCommand,
} from "./bridge-adapters.ts";
import { delay } from "./bridge-adapters.shared.ts";
import { t } from "../i18n/index.ts";
import { BridgeController } from "./bridge-controller.ts";
import { forwardWechatFinalReply } from "./bridge-final-reply.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import { BridgeStateStore } from "./bridge-state.ts";
import { reapOrphanedOpencodeProcesses, reapPeerBridgeProcesses } from "./bridge-process-reaper.ts";
import { createRuntimeHost } from "../runtime/create-runtime-host.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeEvent,
  BridgeLifecycleMode,
  BridgeSessionStartMode,
  BridgeTurnOrigin,
  BridgeWorkerStatus,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "./bridge-types.ts";
import {
  buildWechatInboundPrompt,
  buildOneTimeCode,
  formatApprovalMessage,
  formatPendingApprovalReminder,
  formatPendingUserInputReminder,
  formatDuration,
  formatMirroredUserInputMessage,
  formatSessionSwitchMessage,
  formatStatusReport,
  formatTaskFailedMessage,
  formatThinkingForWechat,
  formatUserInputRequestMessage,
  MESSAGE_START_GRACE_MS,
  nowIso,
  OutputBatcher,
  parsePendingUserInputAnswerCommand,
  parseWechatControlCommand,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  classifyWechatTransportError,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  WeChatTransport,
  describeWechatTransportError,
  isWechatContextTokenStaleError,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  checkForUpdate,
  formatUpdateMessage,
} from "../utils/version-checker.ts";
import {
  clearDaemonEndpoint,
  isDaemonEndpointAlive,
  readDaemonEndpoint,
} from "../daemon/daemon-link.ts";
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
} from "../daemon/emoji-bindings.ts";

type BridgeCliOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  lifecycle: BridgeLifecycleMode;
  sessionStartMode: BridgeSessionStartMode;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

type DeferredInboundMessage = {
  message: InboundWechatMessage;
};

type WechatSendContext =
  | "final_reply"
  | "message"
  | "notice"
  | "approval_required"
  | "user_input_required"
  | "mirrored_user_input"
  | "session_switched"
  | "thread_switched"
  | "task_failed"
  | "fatal_error"
  | "inbound_error"
  | "thinking";

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const PARENT_PROCESS_POLL_MS = 5_000;
const WECHAT_SEND_MAX_ATTEMPTS = 3;
const WECHAT_SEND_RETRY_BASE_MS = 750;

function log(message: string): void {
  process.stderr.write(`[wechat-bridge] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-bridge] ERROR: ${message}\n`);
}

function computePollRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, consecutiveFailures);
  const exponent = Math.min(normalizedFailures - 1, 5);
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** exponent);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatUserFacingBridgeFatalError(message: string): string {
  return `Bridge error: ${message.replace(/\s+Recent app-server log:.*$/s, "").trim()}`;
}

export function shouldForwardBridgeEventToWechat(
  adapter: BridgeAdapterKind,
  eventType: BridgeEvent["type"],
  options: {
    text?: string;
  } = {},
): boolean {
  if (adapter !== "opencode") {
    return true;
  }

  switch (eventType) {
    case "stdout":
    case "stderr":
    case "thread_switched":
      return false;
    case "notice":
      return /^OpenCode local draft:\s*/i.test(options.text ?? "");
    case "mirrored_user_input":
      return true;
    default:
      return true;
  }
}

export function formatUserFacingInboundError(params: {
  adapter: BridgeAdapterKind;
  cwd?: string;
  errorText: string;
  isUserFacingShellRejection: boolean;
}): string {
  const { adapter, cwd, errorText, isUserFacingShellRejection } = params;
  if (isUserFacingShellRejection) {
    return errorText;
  }

  if (
    adapter === "opencode" &&
    /opencode companion is not connected/i.test(errorText)
  ) {
    return cwd
      ? `OpenCode companion is not connected for bridge workspace:\n${cwd}\nRun "wechat-opencode" in that directory to reconnect the current local terminal, or run "wechat-bridge-opencode" and then "wechat-opencode" in your target project to replace this bridge.`
      : 'OpenCode companion is not connected. Start "wechat-opencode" in this directory to reconnect it, then retry.';
  }

  return `Bridge error: ${errorText}`;
}

export function formatWechatSendFailureLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_send_failed: context=${params.context} recipient=${params.recipientId} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function formatWechatContextTokenStaleLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_context_token_stale: context=${params.context} recipient=${params.recipientId} action=wechat_message_required error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

function formatWechatSendRetryLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  attempt: number;
  delayMs: number;
  error: unknown;
}): string {
  return `wechat_send_retry: context=${params.context} recipient=${params.recipientId} attempt=${params.attempt} delay_ms=${params.delayMs} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function isRetryableWechatSendError(error: unknown): boolean {
  if (isWechatContextTokenStaleError(error)) {
    return false;
  }

  const classification = classifyWechatTransportError(error);
  if (classification.retryable) {
    return true;
  }

  const details = describeWechatTransportError(error);
  return /^(?:Error|WechatApiResponseError): sendmessage failed:/i.test(details) &&
    !/errcode=-14\b.*session timeout/i.test(details);
}

function computeWechatSendRetryDelayMs(attempt: number): number {
  return WECHAT_SEND_RETRY_BASE_MS * attempt;
}

export function shouldWatchParentProcess(options: {
  startupParentPid: number;
  attachedToTerminal: boolean;
  lifecycle: BridgeLifecycleMode;
}): boolean {
  return (
    options.startupParentPid > 1 &&
    (options.attachedToTerminal || options.lifecycle === "companion_bound")
  );
}

function toPendingApproval(request: ApprovalRequest | PendingApproval): PendingApproval {
  if (typeof (request as PendingApproval).code === "string") {
    return request as PendingApproval;
  }

  return {
    ...request,
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

export function shouldDeferCodexInboundMessage(params: {
  adapter: BridgeAdapterKind;
  status: BridgeWorkerStatus;
  activeTurnOrigin?: BridgeTurnOrigin;
  hasPendingConfirmation: boolean;
  hasSystemCommand: boolean;
}): boolean {
  return (
    params.adapter === "codex" &&
    !params.hasPendingConfirmation &&
    !params.hasSystemCommand &&
    params.activeTurnOrigin === "local" &&
    (params.status === "busy" || params.status === "awaiting_approval")
  );
}

export function canDrainDeferredCodexInboundQueue(params: {
  adapter: BridgeAdapterKind;
  deferredCount: number;
  status: BridgeWorkerStatus;
  activeTurnId?: string;
  hasPendingConfirmation: boolean;
  hasPendingUserInput: boolean;
  hasPendingApproval: boolean;
  hasActiveTask: boolean;
}): boolean {
  return (
    params.adapter === "codex" &&
    params.deferredCount > 0 &&
    !params.hasPendingConfirmation &&
    !params.hasPendingUserInput &&
    !params.hasPendingApproval &&
    !params.hasActiveTask &&
    !params.activeTurnId &&
    params.status !== "busy" &&
    params.status !== "awaiting_approval" &&
    params.status !== "awaiting_input"
  );
}

export function formatDeferredCodexInboundQueueMessage(queuePosition: number): string {
  return `Queued for delivery after the current local Codex turn finishes. Queue position: ${queuePosition}.`;
}

export function isRetryableDeferredCodexDrainError(errorText: string): boolean {
  return /still working|approval request is pending|waiting for local terminal input/i.test(
    errorText,
  );
}

export function parseCliArgs(argv: string[]): BridgeCliOptions {
  let adapter: BridgeAdapterKind | null = null;
  let commandOverride: string | undefined;
  let cwd = process.cwd();
  let profile: string | undefined;
  let lifecycle: BridgeLifecycleMode = "persistent";
  let sessionStartMode: BridgeSessionStartMode = "restore";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--adapter":
        if (!next || !["codex", "claude", "opencode", "shell"].includes(next)) {
          throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
        }
        adapter = next as BridgeAdapterKind;
        i += 1;
        break;
      case "--cmd":
        if (!next) {
          throw new Error("--cmd requires a value");
        }
        commandOverride = next;
        i += 1;
        break;
      case "--cwd":
        if (!next) {
          throw new Error("--cwd requires a value");
        }
        cwd = path.resolve(next);
        i += 1;
        break;
      case "--profile":
        if (!next) {
          throw new Error("--profile requires a value");
        }
        profile = next;
        i += 1;
        break;
      case "--lifecycle":
        if (!next || !["persistent", "companion_bound"].includes(next)) {
          throw new Error(`Invalid lifecycle: ${next ?? "(missing)"}`);
        }
        lifecycle = next as BridgeLifecycleMode;
        i += 1;
        break;
      case "--session-start-mode":
        if (!next || !["restore", "new"].includes(next)) {
          throw new Error(`Invalid session start mode: ${next ?? "(missing)"}`);
        }
        sessionStartMode = next as BridgeSessionStartMode;
        i += 1;
        break;
      case "--shutdown-on-parent-exit":
        lifecycle = "companion_bound";
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude|opencode|shell>");
  }

  const defaultCommand = resolveDefaultAdapterCommand(adapter);
  return {
    adapter,
    command: commandOverride ?? defaultCommand,
    cwd,
    profile,
    lifecycle,
    sessionStartMode,
  };
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "Usage: wechat-bridge --adapter <codex|claude|opencode|shell> [--cmd <executable>] [--cwd <path>] [--profile <name-or-path>] [--lifecycle <persistent|companion_bound>] [--session-start-mode <restore|new>]",
      "",
      "Examples:",
      "  wechat-bridge-codex",
      "  wechat-bridge-claude --cwd ~/work/my-project",
      "  wechat-bridge-opencode --cwd ~/work/my-project",
      "  wechat-bridge-shell --cmd pwsh   # headless shell executor for non-interactive commands/scripts",
      "  wechat-bridge-shell --cmd bash   # headless shell executor for non-interactive commands/scripts",
      "  wechat-bridge-codex --lifecycle companion_bound",
      "  bun run bridge:codex            # repo-local development entrypoint",
      "  bun run bridge:opencode          # repo-local development entrypoint",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck();
    process.exit(0);
  }
  const options = parseCliArgs(process.argv.slice(2));
  const daemonEndpoint = readDaemonEndpoint();
  if (daemonEndpoint && await isDaemonEndpointAlive(daemonEndpoint, { timeoutMs: 500 })) {
    throw new Error(
      `wechat-daemon is already running (pid=${daemonEndpoint.pid}, cwd=${daemonEndpoint.cwd}). Stop it before starting a standalone bridge.`,
    );
  }
  if (daemonEndpoint) {
    clearDaemonEndpoint(daemonEndpoint.pid);
    log(`Cleared stale wechat-daemon endpoint for pid=${daemonEndpoint.pid}.`);
  }
  const credentials = await ensureWechatCredentials({
    requireUserId: true,
    validateExisting: true,
    log,
  });
  if (!credentials.userId) {
    throw new Error("Saved WeChat credentials are missing userId.");
  }
  const transport = new WeChatTransport({ log, logError });

  // 非阻塞地检查更新（不影响启动速度，也避免首次登录时打断二维码输出）
  setTimeout(async () => {
    try {
      const versionInfo = await checkForUpdate();
      if (versionInfo?.hasUpdate) {
        log(formatUpdateMessage(versionInfo));
      }
    } catch (error) {
      // 静默失败，不影响正常使用
    }
  }, 3000); // 延迟3秒，确保不影响启动

  const stateStore = new BridgeStateStore({
    ...options,
    authorizedUserId: credentials.userId,
  });
  const reapedPeerPids = await reapPeerBridgeProcesses({
    logger: (message) => stateStore.appendLog(message),
  });
  if (reapedPeerPids.length > 0) {
    log(`Reaped ${reapedPeerPids.length} stale bridge process(es): ${reapedPeerPids.join(", ")}`);
  }

  if (options.adapter === "opencode") {
    const reapedOpencodePids = await reapOrphanedOpencodeProcesses({
      logger: (message) => stateStore.appendLog(message),
    });
    if (reapedOpencodePids.length > 0) {
      log(`Reaped ${reapedOpencodePids.length} orphaned opencode process(es): ${reapedOpencodePids.join(", ")}`);
    }
  }

  let lockRehydratedLogged = false;
  const ensureRuntimeOwnership = (): boolean => {
    const ownership = stateStore.verifyRuntimeOwnership();
    if (!ownership.ok) {
      if (ownership.reason === "superseded") {
        requestShutdown(
          `Bridge instance ${stateStore.getState().instanceId} was superseded by ${ownership.activeInstanceId}. Stopping duplicate bridge.`,
        );
        return false;
      }

      requestShutdown(
        `Bridge instance ${stateStore.getState().instanceId} lost the global lock to pid=${ownership.activePid} (${ownership.activeInstanceId}). Stopping duplicate bridge.`,
      );
      return false;
    }

    if (ownership.rehydratedLock && !lockRehydratedLogged) {
      lockRehydratedLogged = true;
      stateStore.appendLog(
        `lock_rehydrated: pid=${process.pid} instanceId=${stateStore.getState().instanceId} adapter=${options.adapter} cwd=${options.cwd}`,
      );
    }

    return true;
  };

  // Clear any stale endpoint left by a previous bridge for this workspace.
  // This prevents `wechat-*` companions from reconnecting to a dead bridge
  // while the new runtime is still starting up.
  const adapter = createRuntimeHost({
    kind: options.adapter,
    command: options.command,
    cwd: options.cwd,
    profile: options.profile,
    lifecycle: options.lifecycle,
    sessionStartMode: options.sessionStartMode,
    initialSharedSessionId:
      stateStore.getState().sharedSessionId ?? stateStore.getState().sharedThreadId,
    initialResumeConversationId: stateStore.getState().resumeConversationId,
    initialTranscriptPath: stateStore.getState().transcriptPath,
  });
  const controller = new BridgeController(adapter, options.cwd);
  controller.clearLocalClientEndpoint();
  stateStore.appendLog(`Cleared stale companion endpoint for ${options.cwd} before adapter start.`);
  let textSendChain = Promise.resolve();
  let attachmentSendChain = Promise.resolve();
  const pendingWechatForwardTasks = new Set<Promise<void>>();
  let activeTask: ActiveTask | null = null;
  const deferredInboundMessages: DeferredInboundMessage[] = [];
  let drainingDeferredInboundMessages = false;
  let lastOutputAt = 0;
  let lastHeartbeatAt = 0;
  let consecutivePollFailures = 0;

  const queueWechatTextAction = <T>(action: () => Promise<T>) => {
    const run = textSendChain.then(action);
    textSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const queueWechatAttachmentAction = <T>(action: () => Promise<T>) => {
    const run = attachmentSendChain.then(action);
    attachmentSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const queueWechatMessage = (
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ) => {
    return queueWechatTextAction(async () => {
      for (let attempt = 1; attempt <= WECHAT_SEND_MAX_ATTEMPTS; attempt += 1) {
        try {
          await transport.sendText(senderId, text);
          return true;
        } catch (err) {
          if (isWechatContextTokenStaleError(err)) {
            transport.clearCachedContextToken(senderId);
            const hint =
              "WeChat conversation context is stale. Ask the WeChat owner to send any message first, then local terminal replies can sync back to WeChat.";
            logError(`Failed to send WeChat ${context}: ${hint}`);
            stateStore.appendLog(
              formatWechatContextTokenStaleLogEntry({
                context,
                recipientId: senderId,
                error: err,
              }),
            );
            return false;
          }

          if (attempt < WECHAT_SEND_MAX_ATTEMPTS && isRetryableWechatSendError(err)) {
            const delayMs = computeWechatSendRetryDelayMs(attempt);
            logError(
              `Failed to send WeChat ${context} (attempt ${attempt}). Retrying in ${formatDuration(delayMs)}. ${describeWechatTransportError(err)}`,
            );
            stateStore.appendLog(
              formatWechatSendRetryLogEntry({
                context,
                recipientId: senderId,
                attempt,
                delayMs,
                error: err,
              }),
            );
            await delay(delayMs);
            continue;
          }

          logError(`Failed to send WeChat ${context}: ${describeWechatTransportError(err)}`);
          stateStore.appendLog(
            formatWechatSendFailureLogEntry({
              context,
              recipientId: senderId,
              error: err,
            }),
          );
          return false;
        }
      }

      return false;
    });
  };

  const trackWechatForwardTask = (task: Promise<void>): void => {
    const tracked = task
      .catch((error) => {
        logError(`WeChat forward task failed: ${describeWechatTransportError(error)}`);
        stateStore.appendLog(
          `wechat_forward_failed: error=${truncatePreview(describeWechatTransportError(error), 400)}`,
        );
      })
      .finally(() => {
        pendingWechatForwardTasks.delete(tracked);
      });
    pendingWechatForwardTasks.add(tracked);
  };

  const waitForPendingWechatForwardTasks = async (): Promise<void> => {
    while (pendingWechatForwardTasks.size > 0) {
      await Promise.allSettled([...pendingWechatForwardTasks]);
    }
  };

  const outputBatcher = new OutputBatcher(async (text) => {
    await queueWechatMessage(stateStore.getState().authorizedUserId, text);
  });
  const maybeDrainDeferredInboundMessages = async (): Promise<void> => {
    if (drainingDeferredInboundMessages || !ensureRuntimeOwnership()) {
      return;
    }

    const adapterState = adapter.getState();
    if (
      !canDrainDeferredCodexInboundQueue({
        adapter: options.adapter,
        deferredCount: deferredInboundMessages.length,
        status: adapterState.status,
        activeTurnId: adapterState.activeTurnId,
        hasPendingConfirmation: Boolean(stateStore.getState().pendingConfirmation),
        hasPendingUserInput: Boolean(stateStore.getState().pendingUserInput),
        hasPendingApproval: Boolean(adapterState.pendingApproval),
        hasActiveTask: Boolean(activeTask),
      })
    ) {
      return;
    }

    const nextDeferred = deferredInboundMessages.shift();
    if (!nextDeferred) {
      return;
    }

    drainingDeferredInboundMessages = true;
    try {
      stateStore.appendLog(
        `draining_deferred_inbound_input: remaining=${deferredInboundMessages.length} text=${truncatePreview(nextDeferred.message.text)}`,
      );
      const nextTask = await dispatchInboundWechatText({
        message: nextDeferred.message,
        options,
        stateStore,
        adapter,
      });
      activeTask = nextTask;
      lastHeartbeatAt = 0;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      if (isRetryableDeferredCodexDrainError(errorText)) {
        deferredInboundMessages.unshift(nextDeferred);
        stateStore.appendLog(
          `deferred_inbound_blocked: ${truncatePreview(errorText, 400)}`,
        );
        return;
      }

      logError(errorText);
      stateStore.appendLog(`deferred_inbound_error: ${errorText}`);
      await queueWechatMessage(
        nextDeferred.message.senderId,
        formatUserFacingInboundError({
          adapter: options.adapter,
          cwd: options.cwd,
          errorText,
          isUserFacingShellRejection: false,
        }),
        "inbound_error",
      );
    } finally {
      drainingDeferredInboundMessages = false;
    }
  };
  const startupParentPid = process.ppid;
  const attachedToTerminal = Boolean(
    process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY,
  );
  let shutdownPromise: Promise<void> | null = null;
  let requestedExitCode = 0;
  let stdinDetached = false;
  const parentWatchTimer =
    shouldWatchParentProcess({
      startupParentPid,
      attachedToTerminal,
      lifecycle: options.lifecycle,
    })
      ? setInterval(() => {
          if (shutdownPromise || isPidAlive(startupParentPid)) {
            return;
          }
          log(`Parent process ${startupParentPid} exited. Stopping bridge.`);
          void shutdown(0);
        }, PARENT_PROCESS_POLL_MS)
      : null;
  parentWatchTimer?.unref();

  const cleanup = async () => {
    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
    }
    try {
      await outputBatcher.flushNow();
      await waitForPendingWechatForwardTasks();
    } catch {
      // Best effort flush.
    }
    try {
      await textSendChain;
      await attachmentSendChain;
      await waitForPendingWechatForwardTasks();
    } catch {
      // Best effort flush.
    }
    try {
      await adapter.dispose();
    } catch {
      // Best effort shutdown.
    }
    controller.clearLocalClientEndpoint();
    stateStore.releaseLock();
  };

  const shutdown = async (exitCode = 0): Promise<void> => {
    requestedExitCode = exitCode;
    if (!shutdownPromise) {
      shutdownPromise = cleanup().catch((error) => {
        logError(`Shutdown cleanup failed: ${describeWechatTransportError(error)}`);
      });
    }
    await shutdownPromise;
  };

  const requestShutdown = (message: string, exitCode = 0) => {
    if (shutdownPromise) {
      return;
    }
    log(message);
    void shutdown(exitCode).finally(() => process.exit(requestedExitCode));
  };

  process.once("SIGINT", () => {
    requestShutdown("Received SIGINT. Stopping bridge.");
  });
  process.once("SIGTERM", () => {
    requestShutdown("Received SIGTERM. Stopping bridge.");
  });
  process.once("SIGHUP", () => {
    requestShutdown("Terminal session closed. Stopping bridge.");
  });
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => {
      requestShutdown("Received SIGBREAK. Stopping bridge.");
    });
  }
  if (attachedToTerminal) {
    process.stdin.on("close", () => {
      if (stdinDetached) {
        return;
      }
      stdinDetached = true;
      requestShutdown("Standard input closed. Stopping bridge.");
    });
    process.stdin.on("end", () => {
      if (stdinDetached) {
        return;
      }
      stdinDetached = true;
      requestShutdown("Standard input ended. Stopping bridge.");
    });
  }
  process.on("exit", () => {
    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
    }
    stateStore.releaseLock();
  });

  try {
    wireAdapterEvents({
      adapter,
      options,
      transport,
      stateStore,
      outputBatcher,
      queueWechatAttachmentAction,
      queueWechatMessage,
      trackWechatForwardTask,
      maybeDrainDeferredInboundMessages,
      getActiveTask: () => activeTask,
      clearActiveTask: () => {
        activeTask = null;
        lastHeartbeatAt = 0;
      },
      updateLastOutputAt: () => {
        lastOutputAt = Date.now();
      },
      syncSharedSessionState: () => {
        syncSharedSessionState(stateStore, adapter);
      },
      syncLocalClientEndpoint: () => {
        controller.syncLocalClientEndpoint();
      },
      requestShutdown,
    });

    await adapter.start();
    if (!ensureRuntimeOwnership()) {
      return;
    }
    syncSharedSessionState(stateStore, adapter);
    controller.syncLocalClientEndpoint();
    stateStore.appendLog(
      `Bridge started with adapter=${options.adapter} command=${options.command} cwd=${options.cwd}`,
    );

    log(`WeChat bridge is ready for adapter "${options.adapter}".`);
    log(`Working directory: ${options.cwd}`);
    if (options.profile) {
      log(`Profile: ${options.profile}`);
    }
    log(`Authorized WeChat user: ${credentials.userId}`);
    if (options.adapter === "codex") {
      log(
        'Start the visible Codex panel in a second terminal with: wechat-codex',
      );
    } else if (options.adapter === "opencode") {
      log(
        'Start the visible OpenCode companion in a second terminal with: wechat-opencode',
      );
    } else if (options.adapter === "claude") {
      log(
        'Start the visible Claude companion in a second terminal with: wechat-claude',
      );
    } else if (options.adapter === "shell") {
      log(
        "Shell mode runs as a headless remote executor for non-interactive commands and scripts.",
      );
    }

    loadEmojiBindings();
    const welcomeText = t("bridge.welcome", {
      adapter: options.adapter,
      cwd: options.cwd,
      bindings: formatBindingsListMessage(listBindings()),
    });
    await queueWechatMessage(credentials.userId, welcomeText);

    while (true) {
      if (!ensureRuntimeOwnership()) {
        break;
      }

      let pollResult: Awaited<ReturnType<WeChatTransport["pollMessages"]>>;
      try {
        pollResult = await transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: stateStore.getState().bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
      } catch (err) {
        const classification = classifyWechatTransportError(err);
        if (!classification.retryable) {
          throw err;
        }

        consecutivePollFailures += 1;
        const delayMs = computePollRetryDelayMs(consecutivePollFailures);
        const errorText = describeWechatTransportError(err);
        const statusDetails =
          typeof classification.statusCode === "number"
            ? ` status=${classification.statusCode}`
            : "";
        logError(
          `WeChat long poll failed (${classification.kind}${statusDetails}, attempt ${consecutivePollFailures}). Retrying in ${formatDuration(delayMs)}. ${errorText}`,
        );
        stateStore.appendLog(
          `poll_retry: kind=${classification.kind}${statusDetails} attempt=${consecutivePollFailures} delay_ms=${delayMs} error=${truncatePreview(errorText, 400)}`,
        );
        await delay(delayMs);
        continue;
      }

      if (!ensureRuntimeOwnership()) {
        break;
      }

      if (consecutivePollFailures > 0) {
        const recoveredFailures = consecutivePollFailures;
        consecutivePollFailures = 0;
        log(`WeChat long poll recovered after ${recoveredFailures} transient error(s).`);
        stateStore.appendLog(`poll_recovered: failures=${recoveredFailures}`);
      }

      if (pollResult.ignoredBacklogCount > 0) {
        stateStore.incrementIgnoredBacklog(pollResult.ignoredBacklogCount);
        stateStore.appendLog(
          `ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`,
        );
      }

      for (const message of pollResult.messages) {
        if (!ensureRuntimeOwnership()) {
          break;
        }

        stateStore.touchActivity(message.createdAt);
        let nextTask: ActiveTask | null = null;
        try {
          nextTask = await handleInboundMessage({
            message,
            options,
            stateStore,
            adapter,
            queueWechatMessage,
            outputBatcher,
            deferInboundMessage: async (nextMessage) => {
              deferredInboundMessages.push({
                message: nextMessage,
              });
              stateStore.appendLog(
                `deferred_inbound_input: position=${deferredInboundMessages.length} text=${truncatePreview(nextMessage.text)}`,
              );
              await queueWechatMessage(
                nextMessage.senderId,
                formatDeferredCodexInboundQueueMessage(deferredInboundMessages.length),
              );
            },
          });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const isUserFacingShellRejection =
            err instanceof Error && err.name === "ShellCommandRejectedError";
          logError(errorText);
          stateStore.appendLog(
            `${isUserFacingShellRejection ? "inbound_rejected" : "inbound_error"}: ${errorText}`,
          );
          await queueWechatMessage(
            message.senderId,
            formatUserFacingInboundError({
              adapter: options.adapter,
              cwd: options.cwd,
              errorText,
              isUserFacingShellRejection,
            }),
            "inbound_error",
          );
        }
        if (nextTask) {
          activeTask = nextTask;
          lastHeartbeatAt = 0;
        }
        syncSharedSessionState(stateStore, adapter);
        await maybeDrainDeferredInboundMessages();
      }

      const adapterState = adapter.getState();
      const lastSignalAt = Math.max(lastHeartbeatAt, lastOutputAt || activeTask?.startedAt || 0);

      if (
        activeTask &&
        options.adapter === "shell" &&
        adapterState.status === "busy" &&
        Date.now() - lastSignalAt >= 30_000
      ) {
        lastHeartbeatAt = Date.now();
        await queueWechatMessage(
          stateStore.getState().authorizedUserId,
          `${options.adapter} is still running. Waiting for more output...`,
        );
      }
    }
  } finally {
    await shutdown(requestedExitCode);
  }
}

function syncSharedSessionState(
  stateStore: BridgeStateStore,
  adapter: BridgeAdapter,
): void {
  const persistedState = stateStore.getState();
  const persistedSessionId = persistedState.sharedSessionId ?? persistedState.sharedThreadId;
  const adapterState = adapter.getState();
  const adapterSessionId = adapterState.sharedSessionId ?? adapterState.sharedThreadId;

  if (adapterSessionId && adapterSessionId !== persistedSessionId) {
    stateStore.setSharedSessionId(adapterSessionId);
  } else if (!adapterSessionId && persistedSessionId) {
    stateStore.clearSharedSessionId();
  }

  if (persistedState.adapter !== "claude") {
    return;
  }

  if (
    adapterState.resumeConversationId !== persistedState.resumeConversationId ||
    adapterState.transcriptPath !== persistedState.transcriptPath
  ) {
    if (adapterState.resumeConversationId || adapterState.transcriptPath) {
      stateStore.setClaudeResumeState(
        adapterState.resumeConversationId,
        adapterState.transcriptPath,
      );
    } else {
      stateStore.clearClaudeResumeState();
    }
  }
}

function wireAdapterEvents(params: {
  adapter: BridgeAdapter;
  options: BridgeCliOptions;
  transport: WeChatTransport;
  stateStore: BridgeStateStore;
  outputBatcher: OutputBatcher;
  queueWechatAttachmentAction: <T>(action: () => Promise<T>) => Promise<T>;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<boolean>;
  trackWechatForwardTask: (task: Promise<void>) => void;
  maybeDrainDeferredInboundMessages: () => Promise<void>;
  getActiveTask: () => ActiveTask | null;
  clearActiveTask: () => void;
  updateLastOutputAt: () => void;
  syncSharedSessionState: () => void;
  syncLocalClientEndpoint: () => void;
  requestShutdown: (message: string, exitCode?: number) => void;
}): void {
  const {
    adapter,
    options,
    transport,
    stateStore,
    outputBatcher,
    queueWechatAttachmentAction,
    queueWechatMessage,
    trackWechatForwardTask,
    maybeDrainDeferredInboundMessages,
    getActiveTask,
    clearActiveTask,
    updateLastOutputAt,
    syncSharedSessionState,
    syncLocalClientEndpoint,
    requestShutdown,
  } = params;

  adapter.setEventSink((event) => {
    syncSharedSessionState();
    syncLocalClientEndpoint();
    const adapterState = adapter.getState();
    const bridgeState = stateStore.getState();
    if (bridgeState.pendingConfirmation && !adapterState.pendingApproval) {
      stateStore.clearPendingConfirmation();
    }
    if (bridgeState.pendingUserInput && !adapterState.pendingUserInput) {
      stateStore.clearPendingUserInput();
    }
    const authorizedUserId = stateStore.getState().authorizedUserId;

    switch (event.type) {
      case "stdout":
      case "stderr":
        updateLastOutputAt();
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type)) {
          outputBatcher.push(event.text);
        }
        break;
      case "final_reply":
        stateStore.appendLog(`final_reply: ${truncatePreview(event.text)}`);
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await forwardWechatFinalReply({
            adapter: options.adapter,
            rawText: event.text,
            onEmptyVisibleReply: ({ rawVisibleText }) => {
              stateStore.appendLog(
                `empty_visible_final_reply: adapter=${options.adapter} raw=${truncatePreview(rawVisibleText)}`,
              );
            },
            sender: {
              sendText: async (text) => {
                const sent = await queueWechatMessage(
                  authorizedUserId,
                  text,
                  "final_reply",
                );
                if (sent) {
                  stateStore.appendLog(
                    `final_reply_sent: chars=${Array.from(text).length}`,
                  );
                }
                return sent;
              },
              sendImage: (imagePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendImage(imagePath, { recipientId: authorizedUserId }),
                ),
              sendFile: (filePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendFile(filePath, { recipientId: authorizedUserId }),
                ),
              sendVoice: (voicePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendVoice(voicePath, authorizedUserId),
                ),
              sendVideo: (videoPath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendVideo(videoPath, { recipientId: authorizedUserId }),
                ),
            },
          });
        }));
        break;
      case "status":
        if (event.message) {
          log(`${event.status}: ${event.message}`);
          stateStore.appendLog(`${event.status}: ${event.message}`);
        }
        void maybeDrainDeferredInboundMessages();
        break;
      case "notice":
        updateLastOutputAt();
        stateStore.appendLog(`${event.level}_notice: ${truncatePreview(event.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type, { text: event.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, event.text, "notice");
          }));
        }
        break;
      case "thinking":
        updateLastOutputAt();
        if (event.text) {
          const thinkingPreview = formatThinkingForWechat(event.text, 500);
          if (thinkingPreview) {
            stateStore.appendLog(`thinking: ${thinkingPreview}`);
            trackWechatForwardTask((async () => {
              await queueWechatMessage(authorizedUserId, `思考: ${thinkingPreview}`, "thinking");
            })());
          }
        }
        break;
      case "approval_required":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingApproval(event.request);
          stateStore.setPendingConfirmation(pending);
          stateStore.appendLog(
            `Approval requested (${pending.source}): ${pending.commandPreview}`,
          );
          await queueWechatMessage(
            authorizedUserId,
            formatApprovalMessage(pending, adapterState),
            "approval_required",
          );
        }));
        break;
      case "user_input_required":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingUserInput(event.request);
          stateStore.setPendingUserInput(pending);
          stateStore.appendLog(
            `User input requested: questions=${pending.questions.length}`,
          );
          await queueWechatMessage(
            authorizedUserId,
            formatUserInputRequestMessage(pending, adapterState),
            "user_input_required",
          );
        }));
        break;
      case "mirrored_user_input":
        stateStore.appendLog(`mirrored_local_input: ${truncatePreview(event.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type, { text: event.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatMirroredUserInputMessage(options.adapter, event.text),
              "mirrored_user_input",
            );
          }));
        }
        break;
      case "session_switched":
        stateStore.appendLog(
          `session_switched: ${event.sessionId} source=${event.source} reason=${event.reason}`,
        );
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatSessionSwitchMessage({
                adapter: options.adapter,
                sessionId: event.sessionId,
                source: event.source,
                reason: event.reason,
              }),
              "session_switched",
            );
          }));
        }
        break;
      case "thread_switched":
        stateStore.appendLog(
          `thread_switched: ${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatSessionSwitchMessage({
                adapter: options.adapter,
                sessionId: event.threadId,
                source: event.source,
                reason: event.reason,
              }),
              "thread_switched",
            );
          }));
        }
        void maybeDrainDeferredInboundMessages();
        break;
      case "task_complete":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          stateStore.clearPendingUserInput();
          if (options.adapter === "shell") {
            const summary = buildCompletionSummary({
              adapter: options.adapter,
              activeTask: getActiveTask(),
              exitCode: event.exitCode,
              recentOutput: outputBatcher.getRecentSummary(),
            });
            await queueWechatMessage(authorizedUserId, summary);
          }
          clearActiveTask();
          await maybeDrainDeferredInboundMessages();
        }));
        break;
      case "task_failed":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          stateStore.clearPendingUserInput();
          clearActiveTask();
          await queueWechatMessage(
            authorizedUserId,
            formatTaskFailedMessage(options.adapter, event.message),
            "task_failed",
          );
          await maybeDrainDeferredInboundMessages();
        }));
        break;
      case "fatal_error":
        logError(event.message);
        stateStore.appendLog(`fatal_error: ${event.message}`);
        stateStore.clearPendingConfirmation();
        stateStore.clearPendingUserInput();
        clearActiveTask();
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(
            authorizedUserId,
            formatUserFacingBridgeFatalError(event.message),
            "fatal_error",
          );
          await maybeDrainDeferredInboundMessages();
        }));
        break;
      case "shutdown_requested":
        stateStore.appendLog(`shutdown_requested: ${event.reason}`);
        requestShutdown(event.message, event.exitCode ?? 0);
        break;
    }
  });
}

function buildCompletionSummary(params: {
  adapter: BridgeAdapterKind;
  activeTask: ActiveTask | null;
  exitCode?: number;
  recentOutput: string;
}): string {
  const lines = [`${params.adapter} task complete.`];
  if (params.activeTask) {
    lines.push(
      `duration: ${formatDuration(Date.now() - params.activeTask.startedAt)}`,
    );
    lines.push(`input: ${params.activeTask.inputPreview}`);
  }
  if (typeof params.exitCode === "number") {
    lines.push(`exit_code: ${params.exitCode}`);
  }
  lines.push(`recent_output:\n${params.recentOutput}`);
  return lines.join("\n");
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

async function handleInboundMessage(params: {
  message: InboundWechatMessage;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<boolean>;
  outputBatcher: OutputBatcher;
  deferInboundMessage: (message: InboundWechatMessage) => Promise<void>;
}): Promise<ActiveTask | null> {
  let {
    message,
  } = params;
  const {
    options,
    stateStore,
    adapter,
    queueWechatMessage,
    outputBatcher,
    deferInboundMessage,
  } = params;
  const state = stateStore.getState();

  if (message.senderId !== state.authorizedUserId) {
    await queueWechatMessage(
      message.senderId,
      "Unauthorized. This bridge only accepts messages from the configured WeChat owner.",
    );
    return null;
  }

  // Emoji resolution: rewrite message text if it starts with a bound emoji
  const emojiMatch = resolveEmojiCommand(message.text);
  if (emojiMatch) {
    const rewritten = emojiMatch.remainder
      ? `${emojiMatch.command} ${emojiMatch.remainder}`
      : emojiMatch.command;
    message = { ...message, text: rewritten };
  }

  // Emoji binding management commands
  const bindingsCmd = parseEmojiBindingsCommand(message.text);
  if (bindingsCmd) {
    switch (bindingsCmd.type) {
      case "list":
        await queueWechatMessage(message.senderId, formatBindingsListMessage(listBindings()));
        break;
      case "bind":
        setBinding(bindingsCmd.emoji, bindingsCmd.command);
        await queueWechatMessage(message.senderId, `Bound ${bindingsCmd.emoji} → ${bindingsCmd.command}`);
        break;
      case "unbind": {
        const removed = removeBinding(bindingsCmd.emoji);
        await queueWechatMessage(
          message.senderId,
          removed ? `Unbound ${bindingsCmd.emoji}` : `No binding found for ${bindingsCmd.emoji}`,
        );
        break;
      }
    }
    return null;
  }

  if (isBindCommandPrefix(message.text)) {
    await queueWechatMessage(message.senderId, formatBindCommandUsage());
    return null;
  }

  const systemCommand = parseWechatControlCommand(message.text, {
    adapter: options.adapter,
    hasPendingConfirmation: Boolean(state.pendingConfirmation),
    hasPendingUserInput: Boolean(state.pendingUserInput),
  });

  switch (systemCommand?.type) {
    case "status":
      await queueWechatMessage(
        message.senderId,
        formatStatusReport(stateStore.getState(), adapter.getState()),
      );
      return null;
    case "resume": {
      if (options.adapter === "codex") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in codex mode. Use /resume directly inside "wechat-codex"; WeChat will follow the active local thread.',
        );
        return null;
      }
      if (options.adapter === "claude") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
        );
        return null;
      }
      if (options.adapter === "opencode") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in opencode mode. Use /resume directly inside "wechat-opencode"; WeChat will follow the active local session.',
        );
        return null;
      }

      await queueWechatMessage(
        message.senderId,
        `/resume is not available in ${options.adapter} mode.`,
      );
      return null;
    }
    case "new_session": {
      if (!adapter.createSession) {
        await queueWechatMessage(
          message.senderId,
          `/new is not available in ${options.adapter} mode.`,
        );
        return null;
      }
      await outputBatcher.flushNow();
      outputBatcher.clear();
      stateStore.clearPendingConfirmation();
      stateStore.clearPendingUserInput();
      stateStore.clearSharedSessionId();
      await adapter.createSession();
      stateStore.appendLog(`New ${options.adapter} session requested by owner.`);
      return null;
    }
    case "stop": {
      const interrupted = await adapter.interrupt();
      await queueWechatMessage(
        message.senderId,
        interrupted
          ? "Interrupt signal sent to the active worker."
          : "No running worker was available to interrupt.",
      );
      return null;
    }
    case "reset":
      await outputBatcher.flushNow();
      outputBatcher.clear();
      stateStore.clearPendingConfirmation();
      stateStore.clearPendingUserInput();
      stateStore.clearSharedSessionId();
      await adapter.reset();
      stateStore.appendLog("Worker reset by owner.");
      await queueWechatMessage(message.senderId, "Worker session has been reset.");
      return null;
    case "confirm": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending approval request.");
        return null;
      }
      const confirmed = await adapter.resolveApproval("confirm");
      if (!confirmed) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not apply this approval request.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval confirmed: ${pending.commandPreview}`);
      await queueWechatMessage(message.senderId, "Approval confirmed. Continuing...");
      return {
        startedAt: Date.now(),
        inputPreview: pending.commandPreview,
      };
    }
    case "deny": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending approval request.");
        return null;
      }
      const denied = await adapter.resolveApproval("deny");
      if (!denied) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not deny this approval request cleanly.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval denied: ${pending.commandPreview}`);
      await queueWechatMessage(message.senderId, "Approval denied.");
      return null;
    }
    case "answer": {
      const pending = state.pendingUserInput;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending user input request.");
        return null;
      }

      const parsed = parsePendingUserInputAnswerCommand(systemCommand.raw, pending);
      if ("error" in parsed) {
        await queueWechatMessage(message.senderId, parsed.error);
        return null;
      }

      const submitted = await adapter.submitUserInput(parsed.answers);
      if (!submitted) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not apply this answer.",
        );
        return null;
      }

      stateStore.clearPendingUserInput();
      stateStore.appendLog(`User input answered: ${parsed.preview}`);
      await queueWechatMessage(message.senderId, "Answer submitted. Continuing...");
      return {
        startedAt: Date.now(),
        inputPreview: parsed.preview,
      };
    }
  }

  if (state.pendingConfirmation) {
    await queueWechatMessage(
      message.senderId,
      formatPendingApprovalReminder(state.pendingConfirmation, adapter.getState()),
    );
    return null;
  }

  if (state.pendingUserInput) {
    await queueWechatMessage(
      message.senderId,
      formatPendingUserInputReminder(state.pendingUserInput),
    );
    return null;
  }

  const adapterState = adapter.getState();
  if (
    shouldDeferCodexInboundMessage({
      adapter: options.adapter,
      status: adapterState.status,
      activeTurnOrigin: adapterState.activeTurnOrigin,
      hasPendingConfirmation: Boolean(state.pendingConfirmation),
      hasSystemCommand: Boolean(systemCommand),
    })
  ) {
    await deferInboundMessage(message);
    return null;
  }

  if (adapterState.status === "busy") {
    if (
      (options.adapter === "codex" || options.adapter === "opencode") &&
      adapterState.activeTurnOrigin === "local"
    ) {
      await queueWechatMessage(
        message.senderId,
        `${
          options.adapter === "opencode" ? "OpenCode" : "codex"
        } is currently busy with a local terminal turn. Wait for it to finish or use /stop.`,
      );
      return null;
    }

    await queueWechatMessage(
      message.senderId,
      `${options.adapter} is still working. Wait for the current reply or use /stop.`,
    );
    return null;
  }

  return dispatchInboundWechatText({
    message,
    options,
    stateStore,
    adapter,
  });
}

async function dispatchInboundWechatText(params: {
  message: InboundWechatMessage;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
}): Promise<ActiveTask> {
  const { message, options, stateStore, adapter } = params;
  const preview = formatInboundMessagePreview(message);
  const activeTask = {
    startedAt: Date.now(),
    inputPreview: truncatePreview(preview, 180),
  };
  stateStore.appendLog(`Forwarded input to ${options.adapter}: ${truncatePreview(preview)}`);
  await adapter.sendInput(buildWechatInboundPrompt(message.text, message.attachments));
  return activeTask;
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((err) => {
    logError(describeWechatTransportError(err));
    process.exit(1);
  });
}
