#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { BRIDGE_LOG_FILE } from "../wechat/channel-config.ts";
import path from "node:path";
import { t } from "../i18n/index.ts";
import { delay } from "../bridge/bridge-adapters.shared.ts";
import {
  reapOrphanedOpencodeProcesses,
  reapPeerBridgeProcesses,
} from "../bridge/bridge-process-reaper.ts";
import type { BridgeAdapter } from "../bridge/bridge-types.ts";
import {
  buildChannelInboundPrompt,
  formatDuration,
  MESSAGE_START_GRACE_MS,
  truncatePreview,
} from "../bridge/bridge-utils.ts";
import {
  WECHAT_SEND_CONTEXTS,
  formatUserFacingInboundError,
  isWechatSendContext,
  type WechatSendContext,
} from "../channels/wechat/wechat-forwarding.ts";
import { formatBindingsListMessage, listBindings, loadEmojiBindings } from "./emoji-bindings.ts";
import {
  classifyWechatTransportError,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  describeWechatTransportError,
  type WeChatTransport,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import { PendingWechatMessageStore } from "../channels/wechat/wechat-outbound-queue.ts";
import { OutboundDispatcher } from "../core/outbound-dispatcher.ts";
import { createRuntimeHost } from "../runtime/create-runtime-host.ts";
import { InboundConversationContext } from "../core/conversation-routing.ts";
import { resolveDaemonOutboundTarget } from "../core/outbound-target.ts";
import { isDirectModuleRun } from "../core/direct-run.ts";
import type { TelegramTransport } from "../channels/telegram/telegram-transport.ts";
import type { WecomTransport } from "../channels/wecom/wecom-transport.ts";
import type { LocalChannelFiles } from "../channels/local/local-driver.ts";
import {
  createChannelRuntime,
  prepareChannel,
  setupChannel,
  type ChannelRuntime,
  type ChannelSetup,
} from "../channels/channel-registry.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type {
  BridgeChannelId,
  ChannelConversationRef,
  ChannelInboundMessage,
} from "../core/channel-types.ts";
import { readLocalCompanionEndpoint } from "../companion/local-companion-link.ts";
import {
  clearDaemonEndpoint,
  isDaemonEndpointAlive,
  readDaemonEndpoint,
  sendDaemonRequest,
  type DaemonAdapterKind,
  type DaemonRequest,
  type DaemonSendTextResult,
  type DaemonSlotSummary,
  type DaemonStatus,
} from "./daemon-link.ts";
import {
  log,
  logError,
  appendDaemonLog,
  isDaemonAdapterKind,
} from "./daemon-shared.ts";
import { type DaemonCliOptions, parseDaemonCliArgs } from "./daemon-commands.ts";
import {
  type VisibleClientLaunch,
  openVisibleClient,
  isVisibleClientAlive,
} from "./visible-client-launcher.ts";
import { cleanupDaemonBeforeStart, cleanupSingleBridgeBeforeDaemon } from "./daemon-cleanup.ts";
import type { DaemonSlot, EnsureSlotResult } from "./daemon-slot.ts";
import { handleSlotEvent, type SlotEventHost } from "./slot-event-forwarder.ts";
import { DaemonControlCommands } from "./control-commands.ts";
import { SlotManager } from "./slot-manager.ts";
import { InboundRouter } from "./inbound-router.ts";
import { DaemonIpcServer } from "./daemon-ipc-server.ts";
export {
  parseDaemonCliArgs,
  parseDaemonSwitchCommand,
  type DaemonSwitchDirective,
  parseDaemonSwitchDirective,
  defaultDaemonSessionStartMode,
  resolveDaemonSessionStartMode,
  formatDaemonSwitchResultDetail,
  formatDaemonStatus,
} from "./daemon-commands.ts";
export {
  buildVisibleClientLaunchArgs,
  buildWindowsVisibleClientLaunchCommand,
  type VisibleClientLaunch,
  openVisibleClient,
  shouldRestartDeadCodexVisibleRuntime,
  waitForVisibleClientConnection,
  waitForCodexVisibleThread,
} from "./visible-client-launcher.ts";
export {
  type DaemonCleanupResult,
  cleanupDaemonBeforeStart,
  type SingleBridgeCleanupResult,
  cleanupSingleBridgeBeforeDaemon,
} from "./daemon-cleanup.ts";

/** How long an ephemeral daemon waits for its launcher's first slot. */
const EPHEMERAL_STARTUP_IDLE_MS = 60_000;

export type WechatDaemonDeps = {
  localeSettingsFile?: string;
  createRuntime?: typeof createRuntimeHost;
  openVisibleClient?: typeof openVisibleClient;
  isVisibleClientAlive?: typeof isVisibleClientAlive;
  daemonLog?: (message: string) => void;
  pendingWechatMessages?: PendingWechatMessageStore;
  visibleClientConnectTimeoutMs?: number;
  fatalNoticeGraceMs?: number;
  /** Ends the process once an ephemeral daemon has shut down. */
  exitProcess?: (code: number) => void;
};

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;

function computePollRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, consecutiveFailures);
  const exponent = Math.min(normalizedFailures - 1, 5);
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** exponent);
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

export class WechatDaemon {
  private readonly cwd: string;
  private readonly profile?: string;
  private readonly authorizedUserId: string;
  private readonly channel: ChannelRuntime;
  private readonly channelDriver: ChannelDriver;
  private readonly channelId: BridgeChannelId;
  private readonly inboundConversationContext =
    new InboundConversationContext();
  private readonly fallbackConversation: ChannelConversationRef;
  private readonly startedAt = new Date().toISOString();
  private readonly bridgeStartedAtMs = Date.now();
  private backlogNoticeSent = false;
  private readonly outbound: OutboundDispatcher;
  private readonly slotEventHost: SlotEventHost;
  private readonly controls: DaemonControlCommands;
  private readonly slotManager: SlotManager;
  private readonly inbound: InboundRouter;
  private readonly deps: WechatDaemonDeps;
  private shutdownPromise: Promise<void> | null = null;
  /** Started by a launcher; exits after the last window closes. */
  private ephemeral = false;
  private readonly ipcServer = new DaemonIpcServer();

  constructor(params: {
    cwd: string;
    profile?: string;
    deps?: WechatDaemonDeps;
  } & (
    | { setup: ChannelSetup }
    | {
        authorizedUserId: string;
        transport: WeChatTransport | null;
        channelId?: BridgeChannelId;
        accountId?: string;
        wecomTransport?: WecomTransport | null;
        telegramTransport?: TelegramTransport | null;
        localFiles?: LocalChannelFiles | null;
      }
  )) {
    const setup: ChannelSetup = "setup" in params
      ? params.setup
      : {
          channelId: params.channelId ?? "wechat",
          operatorId: params.authorizedUserId,
          accountId: params.accountId,
          transports: {
            wechat: params.transport,
            wecom: params.wecomTransport ?? null,
            telegram: params.telegramTransport ?? null,
            localFiles: params.localFiles ?? null,
          },
        };
    this.cwd = params.cwd;
    this.profile = params.profile;
    this.authorizedUserId = setup.operatorId;
    this.channelId = setup.channelId;
    this.deps = params.deps ?? {};
    this.channel = createChannelRuntime(setup, {
      buildWechatInboundPrompt: buildChannelInboundPrompt,
      log: (message) => this.daemonLog(message),
      logError,
    });
    this.channelDriver = this.channel.driver;
    this.fallbackConversation = this.channelDriver.defaultConversation()
      ?? this.channelDriver.directConversation(this.authorizedUserId);
    this.outbound = new OutboundDispatcher({
      driver: this.channelDriver,
      pending: this.deps.pendingWechatMessages ??
        new PendingWechatMessageStore(this.channel.pendingMessagesFile(this.cwd)),
      resolveSendTarget: (senderId, override) => {
        const activeSlot = this.slotManager.getActiveSlot();
        return resolveDaemonOutboundTarget({
          senderId,
          operatorId: this.authorizedUserId,
          override,
          multiConversation: this.channelDriver.capabilities.multiConversation,
          inboundConversation: this.channelDriver.capabilities.multiConversation
            ? this.inboundConversationContext.get()
            : null,
          activeSlotTarget: activeSlot ? this.resolveSlotOutputTarget(activeSlot) : null,
          fallbackConversation: this.fallbackConversation,
          directConversation: (id) => this.channelDriver.directConversation(id),
        });
      },
      resolveQueuedTarget: (senderId, override) => {
        if (!this.channelDriver.capabilities.multiConversation || senderId !== this.authorizedUserId) {
          return override;
        }
        const activeSlot = this.slotManager.getActiveSlot();
        return override ??
          this.inboundConversationContext.get() ??
          (activeSlot ? this.resolveSlotOutputTarget(activeSlot) : this.fallbackConversation);
      },
      describeError: describeWechatTransportError,
      log: (entry) => this.daemonLog(entry),
      logError,
    });
    this.slotEventHost = {
      channel: this.channel,
      driver: this.channelDriver,
      operatorId: this.authorizedUserId,
      fallbackConversation: this.fallbackConversation,
      outbound: this.outbound,
      queueMessage: (senderId, text, context, targetOverride) =>
        this.queueWechatMessage(senderId, text, context, targetOverride),
      resolveSlotOutputTarget: (slot) => this.resolveSlotOutputTarget(slot),
      maybeDrainDeferredInputs: (slot) => this.inbound.maybeDrainDeferredInputs(slot),
      disposeDeadSlot: (slot) => this.slotManager.disposeDeadSlot(slot),
      releaseSlot: (slot) => this.slotManager.releaseSlot(slot),
      prefix: (slot, text) => this.slotManager.prefix(slot, text),
      isShuttingDown: () => this.shutdownPromise !== null,
      fatalNoticeGraceMs: this.deps.fatalNoticeGraceMs,
      daemonLog: (message) => this.daemonLog(message),
    };
    this.slotManager = new SlotManager({
      cwd: this.cwd,
      profile: this.profile,
      channelId: this.channelId,
      operatorId: this.authorizedUserId,
      visibleClientConnectTimeoutMs: this.deps.visibleClientConnectTimeoutMs,
      createRuntime: (options) => this.createRuntime(options),
      isVisibleClientAlive: (cwd, adapter) => this.isVisibleClientAlive(cwd, adapter),
      openVisibleClient: (options) => this.openVisibleClient(options),
      queueMessage: (senderId, text, context, targetOverride) =>
        this.queueWechatMessage(senderId, text, context, targetOverride),
      resolveSlotOutputTarget: (slot) => this.resolveSlotOutputTarget(slot),
      onSlotEvent: (slot, event) => handleSlotEvent(this.slotEventHost, slot, event),
      isEphemeral: () => this.ephemeral,
      onSlotRemoved: () => this.exitIfIdle(),
      daemonLog: (message) => this.daemonLog(message),
    });
    this.controls = new DaemonControlCommands({
      driver: this.channelDriver,
      localeSettingsFile: this.deps.localeSettingsFile,
      slotManager: this.slotManager,
      queueMessage: (senderId, text, context, targetOverride) =>
        this.queueWechatMessage(senderId, text, context, targetOverride),
      getStatus: () => this.getStatus(),
      ensureSlot: (adapter, options) => this.slotManager.ensureSlot(adapter, options),
      dispatchInboundText: (message, slot) => this.inbound.dispatchInboundText(message, slot),
      daemonLog: (message) => this.daemonLog(message),
    });
    this.inbound = new InboundRouter({
      cwd: this.cwd,
      channelId: this.channelId,
      operatorId: this.authorizedUserId,
      driver: this.channelDriver,
      fallbackConversation: this.fallbackConversation,
      inboundConversationContext: this.inboundConversationContext,
      slotManager: this.slotManager,
      controls: this.controls,
      queueMessage: (senderId, text, context, targetOverride) =>
        this.queueWechatMessage(senderId, text, context, targetOverride),
      shutdown: () => this.shutdown(),
      daemonLog: (message) => this.daemonLog(message),
    });
  }

  /** Slots of the current workspace keyed by adapter, exposed for tests. */
  get slots(): Map<DaemonAdapterKind, DaemonSlot> {
    const cwd = this.slotManager.activeCwd;
    return new Map(this.slotManager.slotsIn(cwd).map((slot) => [slot.adapter, slot]));
  }

  /** Run as a launcher's single-bridge daemon. */
  setEphemeral(ephemeral: boolean): void {
    this.ephemeral = ephemeral;
  }

  /**
   * `wechat-daemon` started in `cwd` while this daemon runs: stay alive after
   * the last window closes and make `cwd` the home workspace.
   */
  promote(cwd: string): { pid: number; wasEphemeral: boolean } {
    const wasEphemeral = this.ephemeral;
    this.ephemeral = false;
    this.slotManager.setHome(cwd);
    this.daemonLog(`promoted: cwd=${cwd} was_ephemeral=${wasEphemeral}`);
    return { pid: process.pid, wasEphemeral };
  }

  /** An ephemeral daemon nobody joined within `ms` exits. */
  startIdleWatch(ms = EPHEMERAL_STARTUP_IDLE_MS): void {
    setTimeout(() => this.exitIfIdle(), ms).unref?.();
  }

  /** An ephemeral daemon stops once no slot is left. */
  private exitIfIdle(): void {
    if (!this.ephemeral || this.shutdownPromise || this.slotManager.allSlots().length > 0) {
      return;
    }
    this.daemonLog("ephemeral_idle_exit: no slot left");
    void this.shutdown().finally(() => (this.deps.exitProcess ?? process.exit)(0));
  }

  set takenOverAdapter(adapter: DaemonAdapterKind | undefined) {
    this.slotManager.takenOverAdapter = adapter;
  }

  private daemonLog(message: string): void {
    (this.deps.daemonLog ?? appendDaemonLog)(message);
  }

  private createRuntime(options: Parameters<typeof createRuntimeHost>[0]): BridgeAdapter {
    return (this.deps.createRuntime ?? createRuntimeHost)(options);
  }

  private isVisibleClientAlive(cwd: string, adapter: DaemonAdapterKind): boolean {
    return (this.deps.isVisibleClientAlive ?? isVisibleClientAlive)(cwd, adapter);
  }

  private openVisibleClient(options: Parameters<typeof openVisibleClient>[0]): VisibleClientLaunch {
    return (this.deps.openVisibleClient ?? openVisibleClient)(options);
  }

  async startIpcServer(): Promise<void> {
    await this.ipcServer.start({
      cwd: this.cwd,
      channelId: this.channelId,
      startedAt: this.startedAt,
      handle: (request) => this.handleDaemonRequest(request),
    });
  }

  getStatus(): DaemonStatus {
    const slots = this.slotManager;
    const workspaces = slots.workspaces();
    return {
      cwd: slots.activeCwd,
      channelId: this.channelId,
      activeAdapter: slots.activeAdapter ?? undefined,
      startedAt: this.startedAt,
      ...(workspaces.length > 1 ? { workspaces } : {}),
      slots: workspaces.flatMap((cwd) => slots.slotsIn(cwd)).map((slot): DaemonSlotSummary => {
        const endpoint = readLocalCompanionEndpoint(slot.cwd, {
          adapter: slot.adapter,
        });
        return {
          adapter: slot.adapter,
          status: slot.runtime.getState().status,
          cwd: slot.cwd,
          companionPid: endpoint?.companionPid,
          pendingApproval: slot.pendingConfirmations.length > 0,
          pendingUserInput: Boolean(slot.pendingUserInput),
        };
      }),
    };
  }

  async runInitialAdapter(options: DaemonCliOptions): Promise<void> {
    if (!options.initialAdapter) {
      return;
    }

    await this.slotManager.ensureSlot(options.initialAdapter, {
      profile: options.profile,
      openVisible: options.openVisible,
    });
  }

  async runPollLoop(): Promise<void> {
    let consecutivePollFailures = 0;
    if (this.channelDriver.start) {
      await this.channelDriver.start({
        onInboundMessage: async (channelMessage) => {
          if (this.shutdownPromise) {
            return;
          }
          await this.inboundConversationContext.run(
            channelMessage.conversation,
            async () => {
              if (this.outbound.hasPending()) {
                await this.outbound.flushPending();
              }
              await this.inbound.handleInboundMessage(
                toLegacyInboundWechatMessage(channelMessage),
              );
            },
          );
        },
        onUnauthorizedSender: async (senderId, chatType) => {
          this.daemonLog(
            `wecom_unauthorized: sender=${senderId} chat_type=${chatType}`,
          );
          if (chatType === "direct") {
            const result = await this.channelDriver.sendText({
              target: this.channelDriver.directConversation(senderId),
              text: t("channel.unauthorized"),
              context: "notice",
              log: (entry) => this.daemonLog(entry),
            });
            if (result.status !== "sent") {
              logError(`Failed to reply unauthorized notice to ${senderId}`);
            }
          }
        },
        onChannelFatal: async (error: Error) => {
          this.daemonLog(`wecom_fatal_error: ${error.message}`);
          await this.shutdown();
        },
        onChannelConnected: async () => {
          if (this.outbound.hasPending()) {
            await this.outbound.flushPending();
          }
        },
      });
      await this.channelDriver.waitUntilReady?.();
    }

    log(`${this.channelDriver.displayName} daemon is ready.`);
    log(`Working directory: ${this.cwd}`);
    log(
      `Switch from ${this.channelDriver.displayName} with /codex, /claude, /opencode, or /pi.`,
    );
    this.daemonLog(`started: channel=${this.channelId} cwd=${this.cwd}`);

    const activeSlot = this.slotManager.getActiveSlot();
    const welcomeText = t("daemon.welcome", {
      channel: this.channelDriver.displayName,
      cwd: this.cwd,
      adapter: activeSlot?.adapter ?? "none",
      bindings: formatBindingsListMessage(listBindings()),
    });
    await this.queueWechatMessage(this.authorizedUserId, welcomeText);

    if (this.channelDriver.capabilities.pushInbound) {
      while (!this.shutdownPromise) {
        await delay(1_000);
      }
      await this.shutdownPromise;
      return;
    }

    const pollTransport = this.channel.pollTransport;
    if (!pollTransport) {
      throw new Error(`The ${this.channelId} poll loop requires a long-poll transport.`);
    }
    while (!this.shutdownPromise) {
      let pollResult: Awaited<ReturnType<WeChatTransport["pollMessages"]>>;
      try {
        pollResult = await pollTransport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: this.bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
      } catch (error) {
        const classification = classifyWechatTransportError(error);
        if (!classification.retryable) {
          throw error;
        }

        consecutivePollFailures += 1;
        const delayMs = computePollRetryDelayMs(consecutivePollFailures);
        const errorText = describeWechatTransportError(error);
        const statusDetails =
          typeof classification.statusCode === "number"
            ? ` status=${classification.statusCode}`
            : "";
        logError(
          `WeChat long poll failed (${classification.kind}${statusDetails}, attempt ${consecutivePollFailures}). Retrying in ${formatDuration(delayMs)}. ${errorText}`,
        );
        this.daemonLog(
          `poll_retry: kind=${classification.kind}${statusDetails} attempt=${consecutivePollFailures} delay_ms=${delayMs} error=${truncatePreview(errorText, 400)}`,
        );
        await delay(delayMs);
        continue;
      }

      if (consecutivePollFailures > 0) {
        log(`WeChat long poll recovered after ${consecutivePollFailures} transient error(s).`);
        this.daemonLog(`poll_recovered: failures=${consecutivePollFailures}`);
        consecutivePollFailures = 0;
      }

      if (pollResult.messages.length > 0 && this.outbound.hasPending()) {
        await this.outbound.flushPending();
      }

      if (pollResult.ignoredBacklogCount > 0) {
        this.daemonLog(`ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`);
        if (!this.backlogNoticeSent) {
          this.backlogNoticeSent = true;
          await this.queueWechatMessage(
            this.authorizedUserId,
            t("bridge.backlogIgnored", {
              count: pollResult.ignoredBacklogCount,
              graceSeconds: Math.round(MESSAGE_START_GRACE_MS / 1000),
            }),
            "notice",
          );
        }
      }

      for (const message of pollResult.messages) {
        try {
          await this.inbound.handleInboundMessage(message);
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          logError(errorText);
          this.daemonLog(`inbound_error: ${errorText}`);
          await this.queueWechatMessage(
            message.senderId,
            formatUserFacingInboundError({
              adapter: this.slotManager.activeAdapter ?? "codex",
              cwd: this.cwd,
              errorText,
            }),
            "inbound_error",
          );
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.cleanup();
    }
    await this.shutdownPromise;
  }

  private async cleanup(): Promise<void> {
    this.daemonLog("shutdown_started");
    // Stop accepting new channel work and abort an in-flight long poll before
    // waiting for queued sends or adapter disposal. Otherwise Ctrl+C can leave
    // the process alive until the 35-second poll timeout and retain the daemon
    // endpoint for the next startup to clean up.
    await this.channel.stop();
    try {
      await this.channelDriver.endAllTyping?.();
    } catch {
      // Best effort shutdown.
    }
    clearDaemonEndpoint();

    for (const slot of this.slotManager.allSlots()) {
      try {
        await slot.outputBatcher.flushNow();
      } catch {
        // Best effort flush.
      }
    }
    await this.outbound.waitForForwardTasks();
    await this.outbound.drainSendChains();
    for (const slot of this.slotManager.clear()) {
      try {
        await slot.runtime.dispose();
      } catch {
        // Best effort shutdown.
      }
      slot.controller.clearLocalClientEndpoint();
    }

    await this.ipcServer.close();
    clearDaemonEndpoint();
    this.daemonLog("shutdown_complete");
  }

  async handleDaemonRequest(request: DaemonRequest): Promise<unknown> {
    switch (request.command) {
      case "status":
        return this.getStatus();
      case "shutdown":
        setTimeout(() => {
          void this.shutdown().finally(() => process.exit(0));
        }, 0);
        return { shuttingDown: true };
      case "ensure_slot":
        return await this.ensureWorkspaceSlot(request);
      case "promote":
        return this.promote(request.cwd);
      case "switch_adapter":
        return await this.slotManager.ensureSlot(request.adapter, {
          profile: request.profile,
          cliArgs: request.cliArgs,
          openVisible: request.openVisible ?? true,
          sessionStartMode: request.sessionStartMode,
          reuseExistingVisible: request.reuseExistingVisible ?? true,
        });
      case "send_text":
        return await this.handleDaemonSendText(request);
      case "forward_input":
        return await this.inbound.forwardInput(request);
    }
  }

  async handleDaemonSendText(
    request: Extract<DaemonRequest, { command: "send_text" }>,
  ): Promise<DaemonSendTextResult> {
    if (!request.text.trim()) {
      throw new Error("send_text requires non-empty text.");
    }
    if (request.channel && request.channel !== this.channelId) {
      throw new Error(`${this.channelId}-daemon cannot send to ${request.channel}.`);
    }
    const context = request.context ?? "message";
    if (!isWechatSendContext(context)) {
      throw new Error(
        `Invalid send_text context: ${JSON.stringify(request.context)}. Valid contexts: ${WECHAT_SEND_CONTEXTS.join(", ")}.`,
      );
    }
    const target = this.channelDriver.capabilities.multiConversation
      ? {
          ...this.channelDriver.directConversation(request.recipientId),
          ...(request.conversationId && request.conversationId !== request.recipientId
            ? { conversationId: request.conversationId }
            : {}),
          ...(request.metadata ? { metadata: request.metadata } : {}),
        }
      : undefined;
    const sent = await this.queueWechatMessage(
      request.recipientId,
      request.text,
      context,
      target,
    );
    return {
      sent,
      recipientId: request.recipientId,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
    };
  }

  /**
   * A launcher asked for a slot. The current workspace switches to it like
   * before; another workspace gets its slot without moving the channel, and
   * the operator is told how to switch there.
   */
  private async ensureWorkspaceSlot(
    request: Extract<DaemonRequest, { command: "ensure_slot" }>,
  ): Promise<EnsureSlotResult> {
    const slots = this.slotManager;
    const activate = slots.isActiveWorkspace(request.cwd);
    const known = slots.hasWorkspace(request.cwd);
    const existing = slots.getSlot(request.cwd, request.adapter);
    if (request.boundToWindow && existing && this.isVisibleClientAlive(request.cwd, request.adapter)) {
      // One window per slot until numbered instances exist; never reset the
      // session of a window that is already running.
      this.daemonLog(`launcher_refused_already_running: adapter=${request.adapter} cwd=${request.cwd}`);
      return {
        activeAdapter: request.adapter,
        cwd: request.cwd,
        created: false,
        openedVisible: false,
        visibleConnected: true,
        visibleReady: true,
        activated: false,
        activationVersion: 0,
        previousActiveCwd: slots.activeCwd,
        alreadyRunning: true,
      };
    }
    const result = await slots.ensureSlot(request.adapter, {
      cwd: request.cwd,
      activate,
      // The launcher runs on this computer in that directory.
      restrictToHome: false,
      boundToWindow: request.boundToWindow,
      profile: request.profile,
      cliArgs: request.cliArgs,
      openVisible: request.openVisible ?? true,
      sessionStartMode: request.sessionStartMode,
      reuseExistingVisible: request.reuseExistingVisible ?? true,
    });
    if (!activate && result.created) {
      const label = slots.workspaceLabel(request.cwd);
      this.daemonLog(`workspace_slot_started: cwd=${request.cwd} adapter=${request.adapter} new_workspace=${!known}`);
      await this.queueWechatMessage(
        this.authorizedUserId,
        t("daemon.workspace.connected", { label, adapter: request.adapter }),
      );
    }
    return result;
  }

  getSlotState(adapter: DaemonAdapterKind): {
    active: boolean;
    hasActiveTask: boolean;
    activeConversationId?: string;
    lastConversationId?: string;
  } | null {
    const slot = this.slotManager.getSlot(this.slotManager.activeCwd, adapter);
    if (!slot) return null;
    return {
      active: this.slotManager.activeAdapter === adapter,
      hasActiveTask: slot.turns.hasActiveTask,
      ...(slot.turns.activeConversation?.conversationId
        ? { activeConversationId: slot.turns.activeConversation.conversationId }
        : {}),
      ...(slot.turns.lastConversation?.conversationId
        ? { lastConversationId: slot.turns.lastConversation.conversationId }
        : {}),
    };
  }

  private resolveSlotOutputTarget(slot: DaemonSlot): ChannelConversationRef {
    return slot.turns.resolveTarget(this.fallbackConversation);
  }

  /** Entry point for one inbound channel message; also driven directly by tests. */
  handleInboundMessage(message: InboundWechatMessage): Promise<void> {
    return this.inbound.handleInboundMessage(message);
  }

  private queueWechatMessage(
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
    targetOverride?: ChannelConversationRef,
  ): Promise<boolean> {
    return this.outbound.queueMessage(senderId, text, context, targetOverride);
  }
}

/**
 * A daemon for this channel is already running. A launcher-started
 * (ephemeral) daemon steps aside; `wechat-daemon` promotes the running one to
 * a persistent daemon homed in this directory instead of replacing it.
 * Returns true when this process has nothing left to do.
 */
async function joinRunningDaemon(options: DaemonCliOptions): Promise<boolean> {
  const endpoint = readDaemonEndpoint();
  if (!endpoint || (endpoint.channelId ?? "wechat") !== (options.channelId ?? "wechat")) {
    return false;
  }
  if (!(await isDaemonEndpointAlive(endpoint))) {
    return false;
  }
  if (options.ephemeral) {
    appendDaemonLog(`ephemeral_start_skipped: running_pid=${endpoint.pid}`);
    return true;
  }
  const promoted = await sendDaemonRequest(endpoint, { command: "promote", cwd: options.cwd });
  if (!promoted.ok) {
    throw new Error(`Could not reach the running daemon (pid ${endpoint.pid}): ${promoted.error ?? "no response"}`);
  }
  if (options.initialAdapter) {
    await sendDaemonRequest(
      endpoint,
      {
        command: "ensure_slot",
        adapter: options.initialAdapter,
        cwd: options.cwd,
        profile: options.profile,
        openVisible: options.openVisible,
      },
      { timeoutMs: 45_000 },
    );
  }
  process.stdout.write(`${t("daemon.cli.promoted", {
    channel: options.channelId ?? "wechat",
    pid: endpoint.pid,
    cwd: options.cwd,
    log: BRIDGE_LOG_FILE,
  })}\n`);
  return true;
}

export async function runDaemon(
  options: DaemonCliOptions,
): Promise<void> {
  const channelId = options.channelId ?? "wechat";
  prepareChannel(channelId, (message) => log(message));
  if (await joinRunningDaemon(options)) {
    return;
  }
  loadEmojiBindings();
  await cleanupDaemonBeforeStart({ cwd: options.cwd });
  const cleanupResult = await cleanupSingleBridgeBeforeDaemon();
  const reapedPeerPids = await reapPeerBridgeProcesses({
    logger: (message) => appendDaemonLog(message),
  });
  if (reapedPeerPids.length > 0) {
    log(`Cleaned ${reapedPeerPids.length} peer bridge process(es): ${reapedPeerPids.join(", ")}`);
  }
  const reapedOpencodePids = await reapOrphanedOpencodeProcesses({
    logger: (message) => appendDaemonLog(message),
  });
  if (reapedOpencodePids.length > 0) {
    log(`Cleaned ${reapedOpencodePids.length} orphaned OpenCode process(es): ${reapedOpencodePids.join(", ")}`);
  }
  const setup = await setupChannel(channelId, {
    cwd: options.cwd,
    log,
    logError,
  });

  const daemon = new WechatDaemon({
    cwd: options.cwd,
    profile: options.profile,
    setup,
  });
  daemon.setEphemeral(options.ephemeral === true);
  if (cleanupResult.action === "stopped" && isDaemonAdapterKind(cleanupResult.lock.adapter)) {
    daemon.takenOverAdapter = cleanupResult.lock.adapter;
  }
  await daemon.startIpcServer();
  if (options.ephemeral) {
    daemon.startIdleWatch();
  }
  try {
    await daemon.runInitialAdapter(options);

    let shutdownInProgress = false;
    const handleSignal = (signal: string) => {
      if (shutdownInProgress) {
        log(`Received ${signal} during shutdown, forcing exit.`);
        process.exit(1);
      }
      shutdownInProgress = true;
      log(`Received ${signal}. Stopping daemon.`);
      // Remove this process's endpoint synchronously so a new terminal can be
      // started immediately even if asynchronous adapter cleanup takes time.
      clearDaemonEndpoint();
      void daemon.shutdown().finally(() => process.exit(0));
    };
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGHUP", () => handleSignal("SIGHUP"));
    if (process.platform === "win32") {
      process.on("SIGBREAK", () => handleSignal("SIGBREAK"));
    }
    process.on("exit", () => {
      clearDaemonEndpoint();
    });

    await daemon.runPollLoop();
  } catch (error) {
    // Abnormal exit (poll loop failure, initial adapter failure): dispose the
    // slot runtimes so adapter child processes are not stranded as orphans.
    await daemon.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck(argv, { mode: "daemon" });
    process.exit(0);
  }
  try {
    await runDaemon(parseDaemonCliArgs(argv));
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isDirectRun = isDirectModuleRun(
  import.meta.url,
  process.argv,
  (import.meta as ImportMeta & { main?: boolean }).main,
);
if (isDirectRun) {
  void main();
}
