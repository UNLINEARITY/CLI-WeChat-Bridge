// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import { parseBridgeControlCommand } from "../core/bridge-control.ts";
import {
  formatPendingApprovalReminder,
  formatPendingUserInputReminder,
  parseWechatControlCommand,
  truncatePreview,
} from "../bridge/bridge-utils.ts";
import {
  formatUserFacingInboundError,
  type WechatSendContext,
} from "../channels/wechat/wechat-forwarding.ts";
import {
  formatBindCommandUsage,
  isBindCommandPrefix,
  parseEmojiBindingsCommand,
  resolveEmojiCommand,
} from "./emoji-bindings.ts";
import type { InboundWechatMessage } from "../wechat/wechat-transport.ts";
import { toChannelInboundMessage } from "../channels/wechat/channel-message.ts";
import { routeBridgeMessage } from "../core/bridge-message-router.ts";
import {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  isRetryableDeferredCodexDrainError,
  shouldDeferCodexInboundMessage,
} from "../core/bridge-defer.ts";
import type { InboundConversationContext } from "../core/conversation-routing.ts";
import type { TurnDispatchResult } from "../core/turn-coordinator.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type { BridgeChannelId, ChannelConversationRef } from "../core/channel-types.ts";
import type { DaemonForwardInputResult, DaemonRequest } from "./daemon-link.ts";
import {
  parseDaemonSwitchCommand,
  parseDaemonSwitchDirective,
  formatNoActiveAdapterMessage,
  formatDaemonSwitchResultDetail,
} from "./daemon-commands.ts";
import {
  type ActiveTask,
  type DaemonSlot,
  prefixDaemonAdapterMessage,
  formatInboundMessagePreview,
} from "./daemon-slot.ts";
import { DaemonControlCommands } from "./control-commands.ts";
import { SlotManager } from "./slot-manager.ts";
import { isSameWorkspaceCwd } from "./daemon-shared.ts";

const MAX_DAEMON_DEFERRED_INPUTS = 32;

export type InboundRouterHost = {
  cwd: string;
  channelId: BridgeChannelId;
  operatorId: string;
  driver: ChannelDriver;
  fallbackConversation: ChannelConversationRef;
  inboundConversationContext: InboundConversationContext;
  slotManager: SlotManager;
  controls: DaemonControlCommands;
  queueMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  shutdown: () => Promise<void>;
  daemonLog: (message: string) => void;
};

/** Routes inbound channel messages and forwarded input to daemon slots. */
export class InboundRouter {
  private readonly host: InboundRouterHost;

  constructor(host: InboundRouterHost) {
    this.host = host;
  }

  async routeDaemonInput(
    slot: DaemonSlot,
    inboundMessage: InboundWechatMessage,
    conversation: ChannelConversationRef,
  ): Promise<{
    kind: "dispatched" | "deferred" | "handled";
    reason?: DaemonForwardInputResult["reason"];
    message?: string;
    queued?: boolean;
    queuePosition?: number;
  }> {
    const runtimeState = slot.runtime.getState();
    const adapterState = slot.turns.hasActiveTask && runtimeState.status === "idle"
      ? { ...runtimeState, status: "busy" as const }
      : runtimeState;
    let reason: DaemonForwardInputResult["reason"];
    let routeMessage: string | undefined;
    let queued = false;
    let queuePosition: number | undefined;
    const sendReminder = (text: string, context: WechatSendContext) =>
      this.host.queueMessage(inboundMessage.senderId, text, context, conversation);

    const routeResult = await routeBridgeMessage({
      message: toChannelInboundMessage(inboundMessage),
      authorized: true,
      command: null,
      adapterState,
      hasPendingApproval: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
      shouldDefer: shouldDeferCodexInboundMessage({
        adapter: slot.adapter,
        status: adapterState.status,
        activeTurnOrigin: adapterState.activeTurnOrigin,
        hasPendingConfirmation: slot.pendingConfirmations.length > 0,
        hasSystemCommand: false,
      }),
      onUnauthorized: async () => undefined,
      handleCommand: async () => false,
      remindPendingApproval: async () => {
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          formatPendingApprovalReminder(slot.pendingConfirmations[0]!, slot.runtime.getState()),
        );
        reason = "pending_approval";
        await sendReminder(routeMessage, "approval_required");
      },
      remindPendingUserInput: async () => {
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          slot.pendingUserInput
            ? formatPendingUserInputReminder(slot.pendingUserInput)
            : t("bridge.input.waiting", { adapter: slot.adapter }),
        );
        reason = "pending_user_input";
        await sendReminder(routeMessage, "user_input_required");
      },
      remindBusy: async () => {
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          t("bridge.busy.remote", { adapter: slot.adapter }),
        );
        reason = "busy";
        await sendReminder(routeMessage, "notice");
      },
      defer: async () => {
        if (slot.deferredInputs.length >= MAX_DAEMON_DEFERRED_INPUTS) {
          routeMessage = prefixDaemonAdapterMessage(
            slot.adapter,
            `The deferred input queue is full (${MAX_DAEMON_DEFERRED_INPUTS}). Wait for the current local turn to finish before retrying.`,
          );
          reason = "busy";
          await sendReminder(routeMessage, "notice");
          return;
        }
        slot.deferredInputs.push({ message: inboundMessage, conversation });
        queuePosition = slot.deferredInputs.length;
        queued = true;
        reason = "deferred";
        routeMessage = prefixDaemonAdapterMessage(
          slot.adapter,
          formatDeferredCodexInboundQueueMessage(queuePosition),
        );
        await sendReminder(routeMessage, "notice");
        this.host.daemonLog(
          `deferred_inbound_input: adapter=${slot.adapter} position=${queuePosition} text=${truncatePreview(inboundMessage.text)}`,
        );
      },
      dispatch: async () => {
        await this.dispatchInboundText(inboundMessage, slot, conversation);
      },
    });
    if (routeResult.kind === "dispatched") {
      return { kind: "dispatched" };
    }
    return {
      kind: routeResult.kind,
      reason: reason ?? (routeResult.kind === "deferred" ? "deferred" : "busy"),
      message: routeMessage,
      ...(queued ? { queued: true } : {}),
      ...(queuePosition !== undefined ? { queuePosition } : {}),
    };
  }

  async maybeDrainDeferredInputs(slot: DaemonSlot): Promise<void> {
    if (slot.drainingDeferredInputs) return;
    const state = slot.runtime.getState();
    if (!canDrainDeferredCodexInboundQueue({
      adapter: slot.adapter,
      deferredCount: slot.deferredInputs.length,
      status: state.status,
      activeTurnId: state.activeTurnId,
      hasPendingConfirmation: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
      hasPendingApproval: Boolean(state.pendingApproval),
      hasActiveTask: slot.turns.hasActiveTask,
    })) return;
    const next = slot.deferredInputs.shift();
    if (!next) return;
    slot.drainingDeferredInputs = true;
    try {
      const routed = await this.host.inboundConversationContext.run(
        next.conversation ?? this.host.fallbackConversation,
        () => this.routeDaemonInput(slot, next.message, next.conversation ?? this.host.fallbackConversation),
      );
      if (routed.kind !== "dispatched") {
        slot.deferredInputs.unshift(next);
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      if (isRetryableDeferredCodexDrainError(errorText)) {
        slot.deferredInputs.unshift(next);
      } else {
        await this.host.queueMessage(
          next.message.senderId,
          formatUserFacingInboundError({ adapter: slot.adapter, cwd: this.host.cwd, errorText }),
          "inbound_error",
          next.conversation,
        );
      }
    } finally {
      slot.drainingDeferredInputs = false;
    }
  }

  private bindCurrentConversation(slot: DaemonSlot | null): void {
    const conversation = this.host.inboundConversationContext.get();
    if (!this.host.driver.capabilities.multiConversation || !slot || !conversation) {
      return;
    }
    slot.turns.observeConversation(conversation);
  }

  async handleInboundMessage(message: InboundWechatMessage): Promise<void> {
    if (message.senderId !== this.host.operatorId) {
      await this.host.queueMessage(
        message.senderId,
        t("bridge.unauthorized", { mode: t("bridge.mode.daemon"), operator: this.host.driver.operatorDescription }),
      );
      return;
    }

    const languageCommand = parseBridgeControlCommand(message.text);
    if (languageCommand?.type === "language") {
      await this.host.controls.handleLanguageCommand(message.senderId, languageCommand.target);
      return;
    }

    const emojiMatch = resolveEmojiCommand(message.text);
    if (emojiMatch) {
      const switchTarget = parseDaemonSwitchCommand(emojiMatch.command);
      if (switchTarget && emojiMatch.remainder) {
        const result = await this.host.slotManager.ensureSlot(switchTarget, {
          openVisible: true,
          reuseExistingVisible: true,
        });
        if (result.activated) {
          this.bindCurrentConversation(this.host.slotManager.getActiveSlot());
          message = { ...message, text: emojiMatch.remainder };
        } else {
          const detail = formatDaemonSwitchResultDetail(result);
          await this.host.queueMessage(
            message.senderId,
            t("daemon.activateFailed", { adapter: switchTarget, detail }),
          );
          return;
        }
      } else {
        const rewritten = emojiMatch.remainder
          ? `${emojiMatch.command} ${emojiMatch.remainder}`
          : emojiMatch.command;
        message = { ...message, text: rewritten };
      }
    }

    const switchDirective = parseDaemonSwitchDirective(message.text);
    if (switchDirective) {
      const result = await this.host.slotManager.ensureSlot(switchDirective.adapter, {
        openVisible: true,
        reuseExistingVisible: true,
      });
      const detail = formatDaemonSwitchResultDetail(result);
      if (!result.activated) {
        await this.host.queueMessage(
          message.senderId,
          t("daemon.activateFailed", { adapter: switchDirective.adapter, detail }),
        );
        return;
      }
      this.bindCurrentConversation(this.host.slotManager.getActiveSlot());
      if (switchDirective.remainder) {
        message = { ...message, text: switchDirective.remainder };
      } else {
        await this.host.queueMessage(
          message.senderId,
          t("daemon.activeTerminal", { adapter: switchDirective.adapter, detail }),
        );
        return;
      }
    }

    if (message.text.trim().toLowerCase() === "/daemon-stop") {
      await this.host.queueMessage(
        message.senderId,
        t("daemon.stopping", { channel: this.host.channelId }),
      );
      setTimeout(() => {
        void this.host.shutdown().finally(() => process.exit(0));
      }, 0);
      return;
    }

    const bindingsCmd = parseEmojiBindingsCommand(message.text);
    if (bindingsCmd) {
      await this.host.controls.handleEmojiBindingsCommand(message.senderId, bindingsCmd);
      return;
    }

    if (isBindCommandPrefix(message.text)) {
      await this.host.queueMessage(message.senderId, formatBindCommandUsage());
      return;
    }

    let slot = this.host.slotManager.getActiveSlot();
    if (!slot) {
      await this.host.queueMessage(message.senderId, formatNoActiveAdapterMessage());
      return;
    }
    this.bindCurrentConversation(slot);

    const routeCurrentMessage = async (
      currentSlot: DaemonSlot,
      command: ReturnType<typeof parseWechatControlCommand>,
    ): Promise<void> => {
      const previousTask = currentSlot.turns.activeTask;
      await routeBridgeMessage({
        message: toChannelInboundMessage(message),
        authorized: true,
        command,
        adapterState: currentSlot.runtime.getState(),
        hasPendingApproval: currentSlot.pendingConfirmations.length > 0,
        hasPendingUserInput: Boolean(currentSlot.pendingUserInput),
        onUnauthorized: async () => undefined,
        handleCommand: async (nextCommand) => {
          await this.host.controls.handleSystemCommand(message, currentSlot, nextCommand);
          return true;
        },
        remindPendingApproval: async () => {
          await this.host.queueMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              currentSlot.adapter,
              formatPendingApprovalReminder(
                currentSlot.pendingConfirmations[0]!,
                currentSlot.runtime.getState(),
              ),
            ),
          );
        },
        remindPendingUserInput: async () => {
          await this.host.queueMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              currentSlot.adapter,
              currentSlot.pendingUserInput
                ? formatPendingUserInputReminder(currentSlot.pendingUserInput)
                : t("bridge.input.waiting", { adapter: currentSlot.adapter }),
            ),
          );
        },
        remindBusy: async () => {
          await this.host.queueMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              currentSlot.adapter,
              t("bridge.busy.remote", { adapter: currentSlot.adapter }),
            ),
          );
        },
        defer: async () => undefined,
        dispatch: async () => {
          await this.dispatchInboundText(message, currentSlot);
        },
      });
      if (
        this.host.driver.capabilities.multiConversation &&
        this.host.inboundConversationContext.get() &&
        currentSlot.turns.activeTask &&
        currentSlot.turns.activeTask !== previousTask
      ) {
        const conversation = this.host.inboundConversationContext.get()!;
        currentSlot.turns.bindConversation(conversation);
      }
    };

    const command = parseWechatControlCommand(message.text, {
      adapter: slot.adapter,
      hasPendingConfirmation: slot.pendingConfirmations.length > 0,
      hasPendingUserInput: Boolean(slot.pendingUserInput),
    });
    const slotState = slot.runtime.getState();
    if (
      command ||
      slot.pendingConfirmations.length > 0 ||
      slot.pendingUserInput ||
      slotState.status === "awaiting_input"
    ) {
      await routeCurrentMessage(slot, command);
      return;
    }

    const visibleResult = await this.host.slotManager.ensureSlot(slot.adapter, {
      openVisible: true,
      reuseExistingVisible: true,
    });
    if (!visibleResult.activated) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          formatDaemonSwitchResultDetail(visibleResult),
        ),
      );
      return;
    }
    slot = this.host.slotManager.getActiveSlot() ?? slot;
    this.bindCurrentConversation(slot);
    await routeCurrentMessage(slot, null);
  }

  async dispatchInboundText(
    message: InboundWechatMessage,
    slot: DaemonSlot,
    conversationOverride?: ChannelConversationRef,
  ): Promise<TurnDispatchResult<ActiveTask>> {
    const preview = formatInboundMessagePreview(message);
    const nextTask = {
      startedAt: Date.now(),
      inputPreview: truncatePreview(preview, 180),
    };
    const inboundConversation = this.host.driver.capabilities.multiConversation
      ? conversationOverride ?? this.host.inboundConversationContext.get()
      : undefined;
    const dispatchResult = await slot.turns.dispatch({
      task: nextTask,
      conversation: inboundConversation,
      onBusy: async () => {
        await this.host.queueMessage(
          message.senderId,
          prefixDaemonAdapterMessage(
            slot.adapter,
            t("bridge.busy.remote", { adapter: slot.adapter }),
          ),
          "notice",
          conversationOverride,
        );
      },
      forward: async () => {
        this.host.daemonLog(
          `forwarded_input: adapter=${slot.adapter} text=${truncatePreview(preview)}`,
        );
        await slot.runtime.sendInput(
          this.host.driver.buildInboundPrompt(message.text, message.attachments),
        );
      },
    });
    if (dispatchResult.status === "dispatched") {
      void this.host.driver.beginTyping?.(message.senderId);
    }
    return dispatchResult;
  }

  async forwardInput(
    request: Extract<DaemonRequest, { command: "forward_input" }>,
  ): Promise<DaemonForwardInputResult> {
    if (!request.text.trim()) {
      throw new Error("forward_input requires non-empty text.");
    }
    if (request.cwd && !isSameWorkspaceCwd(request.cwd, this.host.cwd)) {
      throw new Error(
        `${this.host.channelId}-daemon is bound to ${this.host.cwd}; requested cwd was ${request.cwd}.`,
      );
    }

    const adapter = request.adapter ?? this.host.slotManager.activeAdapter;
    if (!adapter) {
      throw new Error("No active adapter slot is available.");
    }
    const senderId = request.senderId ?? this.host.operatorId;
    const conversationId = request.conversationId ?? senderId;
    const conversation: ChannelConversationRef = {
      channelId: this.host.channelId,
      conversationId,
      recipientId: request.recipientId ?? senderId,
      ...(request.contextToken ? { opaqueRef: request.contextToken } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    const previousActiveAdapter = this.host.slotManager.activeAdapter;
    const ensureResult = await this.host.slotManager.ensureSlot(adapter, {
      openVisible: true,
      reuseExistingVisible: true,
    });
    if (!ensureResult.activated) {
      return {
        forwarded: false,
        adapter,
        conversationId,
        reason: "not_activated",
        message: formatDaemonSwitchResultDetail(ensureResult),
      };
    }
    const slot = this.host.slotManager.slots.get(adapter);
    if (!slot) {
      throw new Error(`Adapter slot ${adapter} is not available.`);
    }

    const inboundMessage: InboundWechatMessage = {
      senderId,
      sender: senderId,
      sessionId: conversationId,
      text: request.text,
      attachments: [],
      contextToken: request.contextToken,
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    };

    try {
      const routed = await this.host.slotManager.serializeSlotInput(slot, () =>
        this.host.inboundConversationContext.run(conversation, () =>
          this.routeDaemonInput(slot, inboundMessage, conversation),
        ));
      if (routed.kind === "dispatched") {
        return { forwarded: true, adapter, conversationId };
      }
      this.host.slotManager.restoreActiveAdapterAfterRejectedInput(
        adapter,
        ensureResult.activationVersion,
        previousActiveAdapter,
      );
      return {
        forwarded: false,
        ...(routed.queued ? { queued: true } : {}),
        ...(routed.queuePosition !== undefined ? { queuePosition: routed.queuePosition } : {}),
        adapter,
        conversationId,
        reason: routed.reason,
        message: routed.message,
      };
    } catch (error) {
      this.host.slotManager.restoreActiveAdapterAfterRejectedInput(
        adapter,
        ensureResult.activationVersion,
        previousActiveAdapter,
      );
      throw error;
    }
  }
}
