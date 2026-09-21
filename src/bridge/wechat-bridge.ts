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
  formatUserFacingBridgeFatalError,
  formatUserFacingInboundError,
  shouldForwardBridgeEventToWechat,
  shouldSuppressCodexLocalThreadNotice,
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
import {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  isRetryableDeferredCodexDrainError,
  shouldDeferCodexInboundMessage,
} from "../core/bridge-defer.ts";
import { TurnCoordinator } from "../core/turn-coordinator.ts";
import { resolveOutboundConversationTarget } from "../core/outbound-target.ts";
import { handleAdapterControl } from "./adapter-control.ts";
import { forwardBridgeEvent } from "../core/bridge-event-forwarder.ts";
import { isDirectModuleRun } from "../core/direct-run.ts";
import { WechatChannelPort } from "../channels/wechat/wechat-channel-port.ts";
import { ensureWecomAccount } from "../channels/wecom/setup.ts";
import { WecomChannelPort } from "../channels/wecom/wecom-channel-port.ts";
import { WecomTransport } from "../channels/wecom/wecom-transport.ts";
import { WecomChannelDriver } from "../channels/wecom/wecom-driver.ts";
import { WechatChannelDriver } from "../channels/wechat/wechat-driver.ts";
import type {
  ChannelDriver,
  ChannelSendResult,
} from "../core/channel-driver.ts";
import type {
  BridgeChannelId,
  BridgeChannelPort,
  ChannelConversationRef,
  ChannelInboundMessage,
  ChannelOutputKind,
} from "../core/channel-types.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeLifecycleMode,
  BridgeSessionStartMode,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "./bridge-types.ts";
import {
  buildWechatInboundPrompt,
  type WechatInboundPromptAttachment,
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
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  getPendingChannelMessagesFile,
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

type BridgeCliOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  lifecycle: BridgeLifecycleMode;
  sessionStartMode: BridgeSessionStartMode;
  channelId: BridgeChannelId;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

type DeferredInboundMessage = {
  message: InboundWechatMessage;
  channelMessage?: ChannelInboundMessage;
};


type WechatSendResult = ChannelSendResult;

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

export {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  isRetryableDeferredCodexDrainError,
  shouldDeferCodexInboundMessage,
} from "../core/bridge-defer.ts";

export function parseCliArgs(argv: string[]): BridgeCliOptions {
  let adapter: BridgeAdapterKind | null = null;
  let commandOverride: string | undefined;
  let cwd = process.cwd();
  let profile: string | undefined;
  let lifecycle: BridgeLifecycleMode = "persistent";
  let sessionStartMode: BridgeSessionStartMode = "restore";
  let channelId: BridgeChannelId = "wechat";

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
      case "--channel":
        if (!next || (next !== "wechat" && next !== "wecom")) {
          throw new Error(`Invalid channel: ${next ?? "(missing)"}`);
        }
        channelId = next;
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
    channelId,
  };
}

function toWechatSendContext(kind: ChannelOutputKind): WechatSendContext {
  if (kind === "mirrored_input") {
    return "mirrored_user_input";
  }
  if (kind === "status") {
    return "message";
  }
  return kind;
}

function toLegacyInboundWechatMessage(
  message: ChannelInboundMessage,
): InboundWechatMessage {
  return {
    senderId: message.senderId,
    sender: message.senderId,
    sessionId: message.conversation.conversationId,
    text: message.text,
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind === "image" ? "image" : "file",
      path: attachment.path,
      fileName: attachment.fileName || path.basename(attachment.path),
      sizeBytes: attachment.sizeBytes ?? 0,
    })),
    contextToken: message.conversation.opaqueRef,
    createdAt: message.createdAt,
    createdAtMs: Date.parse(message.createdAt),
  };
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "Internal bridge runtime usage:",
      "  npm run bridge -- --adapter <codex|claude|opencode|pi> [--cmd <executable>] [--cwd <path>] [--profile <name-or-path>] [--lifecycle <persistent|companion_bound>] [--session-start-mode <restore|new>]",
      "",
      "This entry is internal. Users should run a wechat-* or wecom-* launcher.",
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
      `${daemonEndpoint.channelId ?? "wechat"}-daemon is already running (pid=${daemonEndpoint.pid}, cwd=${daemonEndpoint.cwd}). Stop it before starting a standalone bridge.`,
    );
  }
  if (daemonEndpoint) {
    clearDaemonEndpoint(daemonEndpoint.pid);
    log(`Cleared stale wechat-daemon endpoint for pid=${daemonEndpoint.pid}.`);
  }
  const wecomAccount =
    options.channelId === "wecom"
      ? await ensureWecomAccount({ log })
      : null;
  const credentials = wecomAccount
    ? { userId: wecomAccount.operatorUserId }
    : await ensureWechatCredentials({
        requireUserId: true,
        validateExisting: true,
        log,
      });
  if (!credentials.userId) {
    throw new Error(
      options.channelId === "wecom"
        ? "Saved WeCom credentials are missing operatorUserId."
        : "Saved WeChat credentials are missing userId.",
    );
  }
  const transport = new WeChatTransport({ log, logError });
  const wecomTransport = wecomAccount
    ? new WecomTransport({
        account: wecomAccount,
        logger: {
          log: (message) => log(message),
          error: (message) => logError(message),
        },
      })
    : null;
  const channelDriver: ChannelDriver = wecomTransport
    ? new WecomChannelDriver({
        transport: wecomTransport,
        accountId: wecomAccount?.botId,
        operatorId: credentials.userId,
        logError,
      })
    : new WechatChannelDriver({
        transport,
        logError,
        buildInboundPrompt: (text, attachments) =>
          buildWechatInboundPrompt(
            text,
            attachments.filter((attachment): attachment is WechatInboundPromptAttachment =>
              attachment.kind === "image" || attachment.kind === "file"),
          ),
      });

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
    channelId: options.channelId,
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
    options.channelId === "wechat"
      ? getPendingWechatMessagesFile(options.cwd)
      : getPendingChannelMessagesFile(options.cwd, options.channelId),
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
  const defaultConversation = channelDriver.defaultConversation();
  const operatorId = credentials.userId;
  const operatorConversation = defaultConversation
    ?? channelDriver.directConversation(operatorId);
  const turns = new TurnCoordinator<ActiveTask>({
    initialLastConversation: defaultConversation,
  });
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
    targetOverride?: ChannelConversationRef,
  ): Promise<WechatSendResult> => {
    const target = resolveOutboundConversationTarget({
      senderId,
      operatorId,
      override: targetOverride,
      multiConversation: channelDriver.capabilities.multiConversation,
      operatorTarget: turns.resolveTarget(operatorConversation),
      directConversation: (id) => channelDriver.directConversation(id),
    });
    return channelDriver.sendText({
      target,
      text,
      context,
      log: (entry) => stateStore.appendLog(entry),
    });
  };

  const queueWechatMessage = (
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
    targetOverride?: ChannelConversationRef,
  ) => {
    const queuedTarget = senderId === operatorId && channelDriver.capabilities.multiConversation
      ? targetOverride ?? turns.resolveTarget(operatorConversation)
      : targetOverride;
    return queueWechatTextAction(async () => {
      const result = await sendWechatMessageNow(
        senderId,
        text,
        context,
        queuedTarget,
      );
      if (result.status === "target_stale") {
        const pending = pendingWechatMessages.enqueue(
          senderId,
          text,
          context,
          result.target,
        );
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
          pending.target,
        );
        if (result.status === "sent") {
          pendingWechatMessages.remove(pending.id);
          stateStore.appendLog(
            `wechat_pending_sent: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
          );
          continue;
        }
        if (result.status === "target_stale") {
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
    await queueWechatMessage(
      stateStore.getState().authorizedUserId,
      text,
      "message",
      channelDriver.capabilities.multiConversation
        ? turns.resolveTarget(operatorConversation)
        : undefined,
    );
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
        hasActiveTask: turns.hasActiveTask,
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
      const nextTask = createActiveTask(nextDeferred.message);
      const lease = turns.beginTurn(
        nextTask,
        nextDeferred.channelMessage?.conversation,
      );
      if (!lease) {
        deferredInboundMessages.unshift(nextDeferred);
        return;
      }
      try {
        await dispatchInboundWechatText({
          message: nextDeferred.message,
          channelDriver,
          options,
          stateStore,
          adapter,
          activeTask: nextTask,
        });
      } catch (error) {
        turns.rollback(lease);
        throw error;
      }
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
        nextDeferred.channelMessage?.conversation,
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
    try {
      wecomTransport?.stop();
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
      channelDriver,
      resumeCoordinator,
      options,
      transport,
      stateStore,
      outputBatcher,
      queueWechatAttachmentAction,
      queueWechatMessage,
      trackWechatForwardTask,
      maybeDrainDeferredInboundMessages,
      getActiveTask: () => turns.activeTask,
      clearActiveTask: (expectedTask) => {
        if (expectedTask) {
          turns.complete(expectedTask);
        }
      },
      syncSharedSessionState: () => {
        syncSharedSessionState(stateStore, adapter);
      },
      syncLocalClientEndpoint: () => {
        controller.syncLocalClientEndpoint();
      },
      requestShutdown,
      wecomTransport,
      getWecomTarget: () => turns.resolveTarget(operatorConversation),
    });

    await adapter.start();
    if (!ensureRuntimeOwnership()) {
      return;
    }
    syncSharedSessionState(stateStore, adapter);
    controller.syncLocalClientEndpoint();
    stateStore.appendLog(
      `Bridge started with channel=${options.channelId} adapter=${options.adapter} command=${options.command} cwd=${options.cwd}`,
    );

    if (channelDriver.start) {
      await channelDriver.start({
        onInboundMessage: async (channelMessage) => {
          if (shutdownPromise || !ensureRuntimeOwnership()) {
            return;
          }
          turns.observeConversation(channelMessage.conversation);
          const queueInboundReply = (
            senderId: string,
            text: string,
            context?: WechatSendContext,
          ) => queueWechatMessage(
            senderId,
            text,
            context,
            channelMessage.conversation,
          );
          if (pendingWechatMessages.list().length > 0) {
            await flushPendingWechatMessages();
          }
          const message = toLegacyInboundWechatMessage(channelMessage);
          const taskAtMessageStart = turns.activeTask;
          stateStore.touchActivity(message.createdAt);
          try {
            await handleInboundMessage({
              message,
              channelMessage,
              channelDriver,
              options,
              stateStore,
              adapter,
              resumeCoordinator,
              queueWechatMessage: queueInboundReply,
              outputBatcher,
              clearActiveTask: () => {
                if (taskAtMessageStart) {
                  turns.complete(taskAtMessageStart);
                }
              },
              dispatchInboundText: async () => {
                const nextActiveTask = createActiveTask(message);
                const result = await turns.dispatch({
                  task: nextActiveTask,
                  conversation: channelMessage.conversation,
                  onBusy: async () => {
                    await queueInboundReply(
                      message.senderId,
                      `${options.adapter} is still working. Wait for the current reply or use /stop.`,
                    );
                  },
                  forward: async () => {
                    await dispatchInboundWechatText({
                      message,
                      channelDriver,
                      options,
                      stateStore,
                      adapter,
                      activeTask: nextActiveTask,
                    });
                  },
                });
                return result.status === "dispatched" ? nextActiveTask : null;
              },
              deferInboundMessage: async (nextMessage) => {
                deferredInboundMessages.push({
                  message: nextMessage,
                  channelMessage,
                });
                stateStore.appendLog(
                  `deferred_inbound_input: position=${deferredInboundMessages.length} text=${truncatePreview(nextMessage.text)}`,
                );
                await queueInboundReply(
                  nextMessage.senderId,
                  formatDeferredCodexInboundQueueMessage(deferredInboundMessages.length),
                );
              },
            });
          } catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            logError(errorText);
            stateStore.appendLog(`inbound_error: ${errorText}`);
            await queueInboundReply(
              message.senderId,
              formatUserFacingInboundError({
                adapter: options.adapter,
                cwd: options.cwd,
                errorText,
              }),
              "inbound_error",
            );
          }
          syncSharedSessionState(stateStore, adapter);
          await maybeDrainDeferredInboundMessages();
        },
        onUnauthorizedSender: async (senderId, chatType) => {
          stateStore.appendLog(
            `wecom_unauthorized: sender=${senderId} chat_type=${chatType}`,
          );
          if (chatType === "direct") {
            const result = await channelDriver.sendText({
              target: channelDriver.directConversation(senderId),
              text: "Unauthorized.",
              context: "notice",
              log: (entry) => stateStore.appendLog(entry),
            });
            if (result.status !== "sent") {
              logError(`Failed to reply unauthorized notice to ${senderId}`);
            }
          }
        },
        onChannelFatal: async (error: Error) => {
          stateStore.appendLog(`wecom_fatal_error: ${error.message}`);
          requestShutdown(error.message, 1);
        },
        onChannelConnected: async () => {
          if (pendingWechatMessages.list().length > 0) {
            await flushPendingWechatMessages();
          }
        },
      });
      await channelDriver.waitUntilReady?.();
    }

    log(
      `${channelDriver.displayName} bridge is ready for adapter "${options.adapter}".`,
    );
    log(`Working directory: ${options.cwd}`);
    if (options.profile) {
      log(`Profile: ${options.profile}`);
    }
    log(`Authorized ${channelDriver.displayName} user: ${credentials.userId}`);
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

    const welcomeText = t("bridge.welcome", {
      adapter: options.adapter,
      cwd: options.cwd,
    });
    await queueWechatMessage(credentials.userId, welcomeText);

    if (channelDriver.capabilities.pushInbound) {
      while (!shutdownPromise && ensureRuntimeOwnership()) {
        await delay(1_000);
      }
      return;
    }

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

        const taskAtMessageStart = turns.activeTask;
        stateStore.touchActivity(message.createdAt);
        try {
          await handleInboundMessage({
            message,
            channelDriver,
            options,
            stateStore,
            adapter,
            resumeCoordinator,
            queueWechatMessage,
            outputBatcher,
            clearActiveTask: () => {
              if (taskAtMessageStart) {
                turns.complete(taskAtMessageStart);
              }
            },
            dispatchInboundText: async () => {
              const nextActiveTask = createActiveTask(message);
              const result = await turns.dispatch({
                task: nextActiveTask,
                onBusy: async () => {
                  await queueWechatMessage(
                    message.senderId,
                    `${options.adapter} is still working. Wait for the current reply or use /stop.`,
                  );
                },
                forward: async () => {
                  await dispatchInboundWechatText({
                    message,
                    channelDriver,
                    options,
                    stateStore,
                    adapter,
                    activeTask: nextActiveTask,
                  });
                },
              });
              return result.status === "dispatched" ? nextActiveTask : null;
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
  channelDriver: ChannelDriver;
  transport: WeChatTransport;
  stateStore: BridgeStateStore;
  outputBatcher: OutputBatcher;
  queueWechatAttachmentAction: <T>(action: () => Promise<T>) => Promise<T>;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  trackWechatForwardTask: (task: Promise<void>) => void;
  maybeDrainDeferredInboundMessages: () => Promise<void>;
  getActiveTask: () => ActiveTask | null;
  clearActiveTask: (expectedTask: ActiveTask | null) => void;
  syncSharedSessionState: () => void;
  syncLocalClientEndpoint: () => void;
  requestShutdown: (message: string, exitCode?: number) => void;
  wecomTransport?: WecomTransport | null;
  getWecomTarget?: () => ChannelConversationRef;
}): void {
  const {
    adapter,
    channelDriver,
    resumeCoordinator,
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
    syncSharedSessionState,
    syncLocalClientEndpoint,
    requestShutdown,
    wecomTransport,
    getWecomTarget,
  } = params;
  const channelPort: BridgeChannelPort = options.channelId === "wecom"
    ? new WecomChannelPort({
        transport: wecomTransport!,
        sendText: (target, text, kind) =>
          queueWechatMessage(
            stateStore.getState().authorizedUserId,
            text,
            toWechatSendContext(kind),
            target,
          ),
        onEmptyVisibleReply: (adapter, rawText) => {
          stateStore.appendLog(
            `empty_visible_final_reply: adapter=${adapter ?? options.adapter} raw=${truncatePreview(rawText)}`,
          );
        },
      })
    : new WechatChannelPort({
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
  let lastFinalReplyAtMs = 0;
  let eventForwardChain = Promise.resolve();

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
    const eventTarget: ChannelConversationRef = channelDriver.capabilities.multiConversation
      ? getWecomTarget!()
      : channelDriver.directConversation(authorizedUserId);
    const eventTask = getActiveTask();

    eventForwardChain = eventForwardChain
      .then(() => forwardBridgeEvent(event, {
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
        lastFinalReplyAtMs = Date.now();
        stateStore.appendLog(`final_reply: ${truncatePreview(next.text)}`);
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await channelPort.send({
            target: eventTarget,
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
            await queueWechatMessage(authorizedUserId, next.text, "notice", eventTarget);
          }));
        }
      },
      thinking: (next) => {
        if (next.text) {
          const thinkingPreview = formatThinkingForWechat(next.text, 500);
          if (thinkingPreview) {
            stateStore.appendLog(`thinking: ${thinkingPreview}`);
            trackWechatForwardTask((async () => {
              await queueWechatMessage(
                authorizedUserId,
                channelDriver.id === "wecom"
                  ? `Processing: ${thinkingPreview}`
                  : `思考: ${thinkingPreview}`,
                "thinking",
                eventTarget,
              );
            })());
          }
        }
      },
      approvalRequired: (next) => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingApproval(next.request);
          stateStore.setPendingConfirmation(pending);
          stateStore.appendLog(`Approval requested (${pending.source}): ${pending.commandPreview}`);
          await queueWechatMessage(authorizedUserId, formatApprovalMessage(pending, adapterState), "approval_required", eventTarget);
        }));
      },
      userInputRequired: (next) => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingUserInput(next.request);
          stateStore.setPendingUserInput(pending);
          stateStore.appendLog(`User input requested: questions=${pending.questions.length}`);
          await queueWechatMessage(authorizedUserId, formatUserInputRequestMessage(pending, adapterState), "user_input_required", eventTarget);
        }));
      },
      mirroredUserInput: (next) => {
        stateStore.appendLog(`mirrored_local_input: ${truncatePreview(next.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, next.type, { text: next.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, formatMirroredUserInputMessage(options.adapter, next.text), "mirrored_user_input", eventTarget);
          }));
        }
      },
      sessionSwitched: (next) => {
        if (next.source === "local") resumeCoordinator.clear();
        stateStore.appendLog(`session_switched: ${next.sessionId} source=${next.source} reason=${next.reason}`);
        if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(options.adapter, next.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, formatSessionSwitchMessage({ adapter: options.adapter, sessionId: next.sessionId, source: next.source, reason: next.reason }), "session_switched", eventTarget);
          }));
        }
      },
      threadSwitched: (next) => {
        if (next.source === "local") resumeCoordinator.clear();
        stateStore.appendLog(`thread_switched: ${next.threadId} source=${next.source} reason=${next.reason}`);
        if (
          shouldSuppressCodexLocalThreadNotice({
            adapter: options.adapter,
            source: next.source,
            activeTurnOrigin: adapter.getState().activeTurnOrigin,
            lastFinalReplyAtMs,
          })
        ) {
          return;
        }
        if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(options.adapter, next.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(authorizedUserId, formatSessionSwitchMessage({ adapter: options.adapter, sessionId: next.threadId, source: next.source, reason: next.reason }), "thread_switched", eventTarget);
          }));
        }
        void maybeDrainDeferredInboundMessages();
      },
      taskComplete: () => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          stateStore.clearPendingUserInput();
          clearActiveTask(eventTask);
          await maybeDrainDeferredInboundMessages();
        }));
      },
      taskFailed: (next) => {
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          stateStore.clearPendingUserInput();
          clearActiveTask(eventTask);
          await queueWechatMessage(authorizedUserId, formatTaskFailedMessage(options.adapter, next.message), "task_failed", eventTarget);
          await maybeDrainDeferredInboundMessages();
        }));
      },
      fatalError: (next) => {
        logError(next.message);
        stateStore.appendLog(`fatal_error: ${next.message}`);
        stateStore.clearPendingConfirmation();
        stateStore.clearPendingUserInput();
        clearActiveTask(eventTask);
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(authorizedUserId, formatUserFacingBridgeFatalError(next.message), "fatal_error", eventTarget);
          await maybeDrainDeferredInboundMessages();
        }));
      },
      shutdownRequested: (next) => {
        stateStore.appendLog(`shutdown_requested: ${next.reason}`);
        requestShutdown(next.message, next.exitCode ?? 0);
      },
      }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logError(`Bridge event handling failed: ${message}`);
        stateStore.appendLog(`event_forward_failed: ${message}`);
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
  channelMessage?: ChannelInboundMessage;
  options: BridgeCliOptions;
  channelDriver: ChannelDriver;
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
  dispatchInboundText: () => Promise<ActiveTask | null>;
  deferInboundMessage: (message: InboundWechatMessage) => Promise<void>;
}): Promise<ActiveTask | null> {
  const {
    message,
    channelMessage,
    channelDriver,
  } = params;
  const {
    options,
    stateStore,
    adapter,
    resumeCoordinator,
    queueWechatMessage,
    outputBatcher,
    clearActiveTask,
    dispatchInboundText,
    deferInboundMessage,
  } = params;
  const state = stateStore.getState();

  if (message.senderId !== state.authorizedUserId) {
    await queueWechatMessage(
      message.senderId,
      `Unauthorized. This bridge only accepts messages from ${channelDriver.operatorDescription}.`,
    );
    return null;
  }

  const systemCommand = parseWechatControlCommand(message.text, {
    adapter: options.adapter,
    hasPendingConfirmation: Boolean(state.pendingConfirmation),
    hasPendingUserInput: Boolean(state.pendingUserInput),
  });

  switch (systemCommand?.type) {
    case "model":
    case "plan":
      await queueWechatMessage(message.senderId, await handleAdapterControl(adapter, message.senderId, systemCommand));
      return null;
    case "broadcast":
      await queueWechatMessage(
        message.senderId,
        "/all is only available in daemon mode. Start the daemon with wechat-daemon or wecom-daemon to broadcast to all workers.",
      );
      return null;
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
          `${channelDriver.displayName} /resume is disabled in ${options.adapter} mode. Use /resume directly inside "${channelDriver.id}-${options.adapter}"; the remote channel will follow the active local session.`,
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
    message: channelMessage ?? toChannelInboundMessage(message),
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
    dispatch: dispatchInboundText,
  });

  return routeResult.kind === "dispatched" ? routeResult.result as ActiveTask : null;
}

function createActiveTask(message: InboundWechatMessage): ActiveTask {
  return {
    startedAt: Date.now(),
    inputPreview: truncatePreview(formatInboundMessagePreview(message), 180),
  };
}

async function dispatchInboundWechatText(params: {
  message: InboundWechatMessage;
  options: BridgeCliOptions;
  channelDriver: ChannelDriver;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
  activeTask?: ActiveTask;
}): Promise<ActiveTask> {
  const { message, options, channelDriver, stateStore, adapter } = params;
  const preview = formatInboundMessagePreview(message);
  const activeTask = params.activeTask ?? createActiveTask(message);
  stateStore.appendLog(`Forwarded input to ${options.adapter}: ${truncatePreview(preview)}`);
  await adapter.sendInput(
    channelDriver.buildInboundPrompt(message.text, message.attachments),
  );
  return activeTask;
}

const isDirectRun = isDirectModuleRun(
  import.meta.url,
  process.argv,
  (import.meta as ImportMeta & { main?: boolean }).main,
);
if (isDirectRun) {
  main().catch((err) => {
    logError(describeWechatTransportError(err));
    process.exit(1);
  });
}
