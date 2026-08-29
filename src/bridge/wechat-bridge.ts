#!/usr/bin/env bun

import path from "node:path";

import {
  resolveDefaultAdapterCommand,
} from "./bridge-adapters.ts";
import { delay } from "./bridge-adapters.shared.ts";
import { t } from "../i18n/index.ts";
import { BridgeController } from "./bridge-controller.ts";
import {
  ResumeSessionCoordinator,
  isWechatResumeEnabled,
  shouldForwardSessionSwitchEvent,
} from "./bridge-session-resume.ts";
import {
  WECHAT_SEND_MAX_ATTEMPTS,
  computeWechatSendRetryDelayMs,
  formatUserFacingBridgeFatalError,
  formatUserFacingInboundError,
  formatWechatContextTokenStaleLogEntry,
  formatWechatSendFailureLogEntry,
  formatWechatSendRetryLogEntry,
  isWechatContextUnavailableError,
  isRetryableWechatSendError,
  shouldForwardBridgeEventToWechat,
  type WechatSendContext,
} from "../channels/wechat/wechat-forwarding.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import { BridgeStateStore } from "./bridge-state.ts";
import {
  getProcessRecordByPid,
  reapOrphanedOpencodeProcesses,
  reapPeerBridgeProcesses,
} from "./bridge-process-reaper.ts";
import { createRuntimeHost } from "../runtime/create-runtime-host.ts";
import { toChannelInboundMessage } from "../channels/wechat/channel-message.ts";
import { routeBridgeMessage } from "../core/bridge-message-router.ts";
import { forwardBridgeEvent } from "../core/bridge-event-forwarder.ts";
import { WechatChannelPort } from "../channels/wechat/wechat-channel-port.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
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
  getPendingWechatMessagesFile,
  PendingWechatMessageStore,
} from "../channels/wechat/wechat-outbound-queue.ts";
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

type WechatSendResult =
  | { status: "sent" }
  | { status: "context_unavailable"; error: unknown }
  | { status: "failed" };

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const PARENT_PROCESS_POLL_MS = 5_000;
// Hard ceiling for the whole shutdown cleanup sequence before a forced exit.
const SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 10_000;
// Re-verify the parent's command line every N polls (5s each → ~60s) to keep
// the full-process probe off the hot path.
const PARENT_IDENTITY_CHECK_INTERVAL = 12;

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
        if (!next || !["codex", "claude", "opencode", "pi"].includes(next)) {
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
    throw new Error("Missing required --adapter <codex|claude|opencode|pi>");
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
      "Internal bridge runtime usage:",
      "  npm run bridge -- --adapter <codex|claude|opencode|pi> [--cmd <executable>] [--cwd <path>] [--profile <name-or-path>] [--lifecycle <persistent|companion_bound>] [--session-start-mode <restore|new>]",
      "",
      "This entry is internal. Users should run wechat-codex, wechat-claude, wechat-opencode, wechat-pi, or wechat-daemon.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck(process.argv.slice(2), { mode: "bridge" });
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
  // unref：不能让这个延迟检查把 event loop 挂活（如 --doctor 或快速退出场景），
  // 否则会与强制退出 teardown 竞态。
  const updateCheckTimer = setTimeout(async () => {
    try {
      const versionInfo = await checkForUpdate();
      if (versionInfo?.hasUpdate) {
        log(formatUpdateMessage(versionInfo));
      }
    } catch (error) {
      // 静默失败，不影响正常使用
    }
  }, 3000); // 延迟3秒，确保不影响启动
  updateCheckTimer.unref?.();

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
  const pendingWechatMessages = new PendingWechatMessageStore(
    getPendingWechatMessagesFile(options.cwd),
  );
  const resumeCoordinator = new ResumeSessionCoordinator({
    adapter: options.adapter,
    runtime: adapter,
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
  let consecutivePollFailures = 0;
  let backlogNoticeSent = false;

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

  const sendWechatMessageNow = async (
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ): Promise<WechatSendResult> => {
    for (let attempt = 1; attempt <= WECHAT_SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        await transport.sendText(senderId, text);
        return { status: "sent" };
      } catch (err) {
        if (isWechatContextUnavailableError(err)) {
          if (isWechatContextTokenStaleError(err)) {
            transport.clearCachedContextToken(senderId);
          }
          const hint =
            "WeChat conversation context is stale or unavailable. Ask the WeChat owner to send any message first, then local terminal replies can sync back to WeChat.";
          logError(`Failed to send WeChat ${context}: ${hint}`);
          stateStore.appendLog(
            isWechatContextTokenStaleError(err)
              ? formatWechatContextTokenStaleLogEntry({
                  context,
                  recipientId: senderId,
                  error: err,
                })
              : formatWechatSendFailureLogEntry({
                  context,
                  recipientId: senderId,
                  error: err,
                }),
          );
          return { status: "context_unavailable", error: err };
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
        return { status: "failed" };
      }
    }

    return { status: "failed" };
  };

  const queueWechatMessage = (
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ) => {
    return queueWechatTextAction(async () => {
      const result = await sendWechatMessageNow(senderId, text, context);
      if (result.status === "context_unavailable") {
        const pending = pendingWechatMessages.enqueue(senderId, text, context);
        if (pending) {
          stateStore.appendLog(
            `wechat_send_queued: id=${pending.id} context=${context} recipient=${senderId} pending=${pendingWechatMessages.list().length}`,
          );
        }
      }
      return result.status === "sent";
    });
  };

  const flushPendingWechatMessages = () => {
    return queueWechatTextAction(async () => {
      for (const pending of pendingWechatMessages.list()) {
        const result = await sendWechatMessageNow(
          pending.recipientId,
          pending.text,
          pending.context,
        );
        if (result.status === "sent") {
          pendingWechatMessages.remove(pending.id);
          stateStore.appendLog(
            `wechat_pending_sent: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
          );
          continue;
        }
        if (result.status === "context_unavailable") {
          break;
        }
        stateStore.appendLog(
          `wechat_pending_retryable_failure: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
        );
        break;
      }
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
  // Snapshot of the parent process command line at bridge startup (null when
  // unresolvable). Compared against periodic re-probes to detect OS pid reuse.
  const parentStartupCommandLine =
    getProcessRecordByPid(startupParentPid)?.commandLine ?? null;
  let parentWatchPollCount = 0;
  const parentWatchTimer =
    shouldWatchParentProcess({
      startupParentPid,
      attachedToTerminal,
      lifecycle: options.lifecycle,
    })
      ? setInterval(() => {
          if (shutdownPromise || isPidAlive(startupParentPid)) {
            // Periodically re-verify the parent's command line so an OS pid
            // reuse (dead parent's pid handed to an unrelated long-running
            // process) cannot keep this companion-bound bridge alive forever.
            parentWatchPollCount += 1;
            if (parentWatchPollCount % PARENT_IDENTITY_CHECK_INTERVAL === 0) {
              const record = getProcessRecordByPid(startupParentPid);
              if (
                parentStartupCommandLine !== null &&
                record !== null &&
                record.commandLine !== parentStartupCommandLine
              ) {
                log(
                  `Parent pid ${startupParentPid} was reused by another process. Stopping bridge.`,
                );
                void shutdown(0);
              }
            }
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
    // Bound the whole cleanup: a dispose that hangs (child process refusing
    // to exit) would otherwise keep the process alive indefinitely after the
    // one-shot signal handlers are consumed.
    const forceExitTimer = setTimeout(() => {
      logError(
        `Shutdown cleanup exceeded ${formatDuration(SHUTDOWN_FORCE_EXIT_TIMEOUT_MS)}; forcing exit.`,
      );
      process.exit(requestedExitCode);
    }, SHUTDOWN_FORCE_EXIT_TIMEOUT_MS);
    void shutdown(exitCode).finally(() => {
      clearTimeout(forceExitTimer);
      process.exit(requestedExitCode);
    });
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
      resumeCoordinator,
      options,
      transport,
      stateStore,
      outputBatcher,
      queueWechatAttachmentAction,
      queueWechatMessage,
      trackWechatForwardTask,
      maybeDrainDeferredInboundMessages,
      clearActiveTask: () => {
        activeTask = null;
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
        "For source-mode debugging, open the visible Codex client with: npm run codex:panel",
      );
    } else if (options.adapter === "opencode") {
      log(
        "For source-mode debugging, open the visible OpenCode client with: npm run opencode:panel",
      );
    } else if (options.adapter === "claude") {
      log(
        "For source-mode debugging, open the visible Claude client with: npm run claude:companion",
      );
    } else if (options.adapter === "pi") {
      log(
        "For source-mode debugging, open the visible Pi client with: npm run pi:companion",
      );
    }

    loadEmojiBindings();
    // Keep the standalone bridge's WeChat welcome brief: command and emoji
    // reference material belongs to /status and /bindings, which users can
    // request on demand. The daemon sends its own, fuller welcome.
    const welcomeText = t("bridge.welcome", {
      adapter: options.adapter,
      cwd: options.cwd,
    });
    await queueWechatMessage(credentials.userId, welcomeText);

    while (true) {
      if (shutdownPromise) {
        // Shutdown (e.g. SIGINT) was requested while we were awaiting the
        // previous poll: stop consuming inbound messages instead of racing
        // the concurrent cleanup/dispose with new sends.
        break;
      }
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

      if (shutdownPromise || !ensureRuntimeOwnership()) {
        break;
      }

      if (consecutivePollFailures > 0) {
        const recoveredFailures = consecutivePollFailures;
        consecutivePollFailures = 0;
        log(`WeChat long poll recovered after ${recoveredFailures} transient error(s).`);
        stateStore.appendLog(`poll_recovered: failures=${recoveredFailures}`);
      }

      if (pollResult.messages.length > 0 && pendingWechatMessages.list().length > 0) {
        await flushPendingWechatMessages();
      }

      if (pollResult.ignoredBacklogCount > 0) {
        stateStore.incrementIgnoredBacklog(pollResult.ignoredBacklogCount);
        stateStore.appendLog(
          `ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`,
        );
        if (!backlogNoticeSent) {
          backlogNoticeSent = true;
          await queueWechatMessage(
            stateStore.getState().authorizedUserId,
            t("bridge.backlogIgnored", {
              count: pollResult.ignoredBacklogCount,
              graceSeconds: Math.round(MESSAGE_START_GRACE_MS / 1000),
            }),
            "notice",
          );
        }
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
            resumeCoordinator,
            queueWechatMessage,
            outputBatcher,
            clearActiveTask: () => {
              activeTask = null;
            },
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
          logError(errorText);
          stateStore.appendLog(`inbound_error: ${errorText}`);
          await queueWechatMessage(
            message.senderId,
            formatUserFacingInboundError({
              adapter: options.adapter,
              cwd: options.cwd,
              errorText,
            }),
            "inbound_error",
          );
        }
        if (nextTask) {
          activeTask = nextTask;
        }
        syncSharedSessionState(stateStore, adapter);
        await maybeDrainDeferredInboundMessages();
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
  resumeCoordinator: ResumeSessionCoordinator;
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
  clearActiveTask: () => void;
  syncSharedSessionState: () => void;
  syncLocalClientEndpoint: () => void;
  requestShutdown: (message: string, exitCode?: number) => void;
}): void {
  const {
    adapter,
    resumeCoordinator,
    options,
    transport,
    stateStore,
    outputBatcher,
    queueWechatAttachmentAction,
    queueWechatMessage,
    trackWechatForwardTask,
    maybeDrainDeferredInboundMessages,
    clearActiveTask,
    syncSharedSessionState,
    syncLocalClientEndpoint,
    requestShutdown,
  } = params;
  const channelPort = new WechatChannelPort({
    sendText: (recipientId, text, context) =>
      queueWechatMessage(recipientId, text, context as WechatSendContext),
    sendImage: (recipientId, filePath) =>
      queueWechatAttachmentAction(() => transport.sendImage(filePath, { recipientId })),
    sendFile: (recipientId, filePath) =>
      queueWechatAttachmentAction(() => transport.sendFile(filePath, { recipientId })),
    sendVoice: (recipientId, filePath) =>
      queueWechatAttachmentAction(() => transport.sendVoice(filePath, recipientId)),
    sendVideo: (recipientId, filePath) =>
      queueWechatAttachmentAction(() => transport.sendVideo(filePath, { recipientId })),
    onEmptyVisibleReply: (adapter, rawText) => {
      stateStore.appendLog(
        `empty_visible_final_reply: adapter=${adapter ?? options.adapter} raw=${truncatePreview(rawText)}`,
      );
    },
    onTextSent: (_adapter, text) => {
      stateStore.appendLog(`final_reply_sent: chars=${Array.from(text).length}`);
    },
  });

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

    void forwardBridgeEvent(event, {
      stdout: (next) => {
        if (shouldForwardBridgeEventToWechat(options.adapter, next.type)) {
          outputBatcher.push(next.text);
        }
      },
      stderr: (next) => {
        if (shouldForwardBridgeEventToWechat(options.adapter, next.type)) {
          outputBatcher.push(next.text);
        }
      },
      finalReply: (next) => {
        stateStore.appendLog(`final_reply: ${truncatePreview(next.text)}`);
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await channelPort.send({
            target: {
              channelId: "wechat",
              conversationId: authorizedUserId,
              recipientId: authorizedUserId,
            },
            kind: "final_reply",
            text: next.text,
            adapter: options.adapter,
          });
        }));
      },
      status: (next) => {
        if (next.message) {
          log(`${next.status}: ${next.message}`);
          stateStore.appendLog(`${next.status}: ${next.message}`);
        }
        void maybeDrainDeferredInboundMessages();
      },
      notice: (next) => {
        stateStore.appendLog(`${next.level}_notice: ${truncatePreview(next.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, next.type, { text: next.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, next.text, "notice");
          }));
        }
      },
      thinking: (next) => {
        if (next.text) {
          const thinkingPreview = formatThinkingForWechat(next.text, 500);
          if (thinkingPreview) {
            stateStore.appendLog(`thinking: ${thinkingPreview}`);
            trackWechatForwardTask((async () => {
              await queueWechatMessage(authorizedUserId, `思考: ${thinkingPreview}`, "thinking");
            })());
          }
        }
      },
      approvalRequired: (next) => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingApproval(next.request);
          stateStore.setPendingConfirmation(pending);
          stateStore.appendLog(`Approval requested (${pending.source}): ${pending.commandPreview}`);
          await queueWechatMessage(authorizedUserId, formatApprovalMessage(pending, adapterState), "approval_required");
        }));
      },
      userInputRequired: (next) => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingUserInput(next.request);
          stateStore.setPendingUserInput(pending);
          stateStore.appendLog(`User input requested: questions=${pending.questions.length}`);
          await queueWechatMessage(authorizedUserId, formatUserInputRequestMessage(pending, adapterState), "user_input_required");
        }));
      },
      mirroredUserInput: (next) => {
        stateStore.appendLog(`mirrored_local_input: ${truncatePreview(next.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, next.type, { text: next.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, formatMirroredUserInputMessage(options.adapter, next.text), "mirrored_user_input");
          }));
        }
      },
      sessionSwitched: (next) => {
        if (next.source === "local") resumeCoordinator.clear();
        stateStore.appendLog(`session_switched: ${next.sessionId} source=${next.source} reason=${next.reason}`);
        if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(options.adapter, next.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, formatSessionSwitchMessage({ adapter: options.adapter, sessionId: next.sessionId, source: next.source, reason: next.reason }), "session_switched");
          }));
        }
      },
      threadSwitched: (next) => {
        if (next.source === "local") resumeCoordinator.clear();
        stateStore.appendLog(`thread_switched: ${next.threadId} source=${next.source} reason=${next.reason}`);
        if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(options.adapter, next.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, formatSessionSwitchMessage({ adapter: options.adapter, sessionId: next.threadId, source: next.source, reason: next.reason }), "thread_switched");
          }));
        }
        void maybeDrainDeferredInboundMessages();
      },
      taskComplete: () => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          stateStore.clearPendingUserInput();
          clearActiveTask();
          await maybeDrainDeferredInboundMessages();
        }));
      },
      taskFailed: (next) => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          stateStore.clearPendingUserInput();
          clearActiveTask();
          await queueWechatMessage(authorizedUserId, formatTaskFailedMessage(options.adapter, next.message), "task_failed");
          await maybeDrainDeferredInboundMessages();
        }));
      },
      fatalError: (next) => {
        logError(next.message);
        stateStore.appendLog(`fatal_error: ${next.message}`);
        stateStore.clearPendingConfirmation();
        stateStore.clearPendingUserInput();
        clearActiveTask();
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(authorizedUserId, formatUserFacingBridgeFatalError(next.message), "fatal_error");
          await maybeDrainDeferredInboundMessages();
        }));
      },
      shutdownRequested: (next) => {
        stateStore.appendLog(`shutdown_requested: ${next.reason}`);
        requestShutdown(next.message, next.exitCode ?? 0);
      },
    });
  });
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
  resumeCoordinator: ResumeSessionCoordinator;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<boolean>;
  outputBatcher: OutputBatcher;
  clearActiveTask: () => void;
  deferInboundMessage: (message: InboundWechatMessage) => Promise<void>;
}): Promise<ActiveTask | null> {
  let {
    message,
  } = params;
  const {
    options,
    stateStore,
    adapter,
    resumeCoordinator,
    queueWechatMessage,
    outputBatcher,
    clearActiveTask,
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
      if (!isWechatResumeEnabled(options.adapter)) {
        await queueWechatMessage(
          message.senderId,
          `WeChat /resume is disabled in ${options.adapter} mode. Use /resume directly inside "wechat-${options.adapter}"; WeChat will follow the active local session.`,
        );
        return null;
      }
      try {
        if (systemCommand.target) {
          await outputBatcher.flushNow();
        }
        const result = await resumeCoordinator.execute(systemCommand.target);
        if (result.kind === "resumed") {
          clearActiveTask();
        }
        await queueWechatMessage(message.senderId, result.message);
      } catch (error) {
        await queueWechatMessage(
          message.senderId,
          error instanceof Error ? error.message : String(error),
        );
      }
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
      resumeCoordinator.clear();
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
      resumeCoordinator.clear();
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

  const adapterState = adapter.getState();
  const routeResult = await routeBridgeMessage({
    message: toChannelInboundMessage(message),
    authorized: true,
    command: null,
    adapterState,
    hasPendingApproval: Boolean(state.pendingConfirmation),
    hasPendingUserInput: Boolean(state.pendingUserInput),
    shouldDefer: shouldDeferCodexInboundMessage({
      adapter: options.adapter,
      status: adapterState.status,
      activeTurnOrigin: adapterState.activeTurnOrigin,
      hasPendingConfirmation: Boolean(state.pendingConfirmation),
      hasSystemCommand: Boolean(systemCommand),
    }),
    onUnauthorized: async () => undefined,
    handleCommand: async () => false,
    remindPendingApproval: async () => {
      await queueWechatMessage(
        message.senderId,
        formatPendingApprovalReminder(stateStore.getState().pendingConfirmation!, adapter.getState()),
      );
    },
    remindPendingUserInput: async () => {
      const pendingUserInput = stateStore.getState().pendingUserInput;
      await queueWechatMessage(
        message.senderId,
        pendingUserInput
          ? formatPendingUserInputReminder(pendingUserInput)
          : `${options.adapter} is waiting for structured input. Reply with /answer <key>=<value> ...`,
      );
    },
    remindBusy: async () => {
      const currentState = adapter.getState();
      if (
        (options.adapter === "codex" || options.adapter === "opencode" || options.adapter === "pi") &&
        currentState.activeTurnOrigin === "local"
      ) {
        await queueWechatMessage(
          message.senderId,
          `${
            options.adapter === "opencode" ? "OpenCode" : options.adapter === "pi" ? "Pi" : "codex"
          } is currently busy with a local terminal turn. Wait for it to finish or use /stop.`,
        );
        return;
      }

      await queueWechatMessage(
        message.senderId,
        `${options.adapter} is still working. Wait for the current reply or use /stop.`,
      );
    },
    defer: async () => {
      await deferInboundMessage(message);
    },
    dispatch: async () => {
      return await dispatchInboundWechatText({
        message,
        options,
        stateStore,
        adapter,
      });
    },
  });

  return routeResult.kind === "dispatched" ? routeResult.result as ActiveTask : null;
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
