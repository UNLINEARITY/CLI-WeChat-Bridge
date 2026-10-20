// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import { parseBridgeControlCommand } from "../core/bridge-control.ts";
import { formatPendingApprovalReminder } from "../bridge/message-formatting.ts";
import { formatPendingUserInputReminder } from "../bridge/user-input-messages.ts";
import { parseControlCommand, truncatePreview } from "../bridge/bridge-utils.ts";
import {
  formatUserFacingInboundError,
  type ChannelSendKind,
} from "../channels/wechat/wechat-forwarding.ts";
import {
  formatBindCommandUsage,
  isBindCommandPrefix,
  parseEmojiBindingsCommand,
  resolveEmojiCommand,
} from "./emoji-bindings.ts";
import type { BridgeInboundMessage } from "../core/channel-types.ts";
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
import type { TypingTracker } from "./typing-tracker.ts";
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
  type EnsureSlotResult,
  currentUserInputIndex,
  formatInboundMessagePreview,
} from "./daemon-slot.ts";
import { DaemonControlCommands } from "./control-commands.ts";
import { SlotManager } from "./slot-manager.ts";
import { modeAllowsCommand } from "./bridge-mode.ts";

const MAX_DAEMON_DEFERRED_INPUTS = 32;

export type InboundRouterHost = {
  typing: TypingTracker;
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
    context?: ChannelSendKind,
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
    inboundMessage: BridgeInboundMessage,
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
    const sendReminder = (text: string, context: ChannelSendKind) =>
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
        routeMessage = this.host.slotManager.prefix(
          slot,
          formatPendingApprovalReminder(slot.pendingConfirmations[0]!, slot.runtime.getState()),
        );
        reason = "pending_approval";
        await sendReminder(routeMessage, "approval_required");
        slot.displayedApprovalRequestId = slot.pendingConfirmations[0]?.requestId;
      },
      remindPendingUserInput: async () => {
        routeMessage = this.host.slotManager.prefix(
          slot,
          slot.pendingUserInput
            ? formatPendingUserInputReminder(slot.pendingUserInput, currentUserInputIndex(slot))
            : t("bridge.input.waiting", { adapter: slot.adapter }),
        );
        reason = "pending_user_input";
        await sendReminder(routeMessage, "user_input_required");
      },
      remindBusy: async () => {
        routeMessage = this.host.slotManager.prefix(
          slot,
          t("bridge.busy.remote", { adapter: slot.adapter }),
        );
        reason = "busy";
        await sendReminder(routeMessage, "notice");
      },
      defer: async () => {
        const deferred = await this.deferInput(slot, inboundMessage, conversation);
        routeMessage = deferred.text;
        reason = deferred.position === undefined ? "busy" : "deferred";
        if (deferred.position !== undefined) {
          queued = true;
          queuePosition = deferred.position;
        }
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

  /**
   * Queue input that arrived during a local Codex turn; it is replayed once
   * the turn settles. Returns the reply sent to the user and, when queued,
   * the queue position.
   */
  private async deferInput(
    slot: DaemonSlot,
    inboundMessage: BridgeInboundMessage,
    conversation: ChannelConversationRef | undefined,
  ): Promise<{ text: string; position?: number }> {
    if (slot.deferredInputs.length >= MAX_DAEMON_DEFERRED_INPUTS) {
      const text = this.host.slotManager.prefix(
        slot,
        `The deferred input queue is full (${MAX_DAEMON_DEFERRED_INPUTS}). Wait for the current local turn to finish before retrying.`,
      );
      await this.host.queueMessage(inboundMessage.senderId, text, "notice", conversation);
      return { text };
    }
    slot.deferredInputs.push({ message: inboundMessage, conversation });
    const position = slot.deferredInputs.length;
    const text = this.host.slotManager.prefix(
      slot,
      formatDeferredCodexInboundQueueMessage(position),
    );
    await this.host.queueMessage(inboundMessage.senderId, text, "notice", conversation);
    this.host.daemonLog(
      `deferred_inbound_input: adapter=${slot.adapter} cwd=${slot.cwd} position=${position} text=${truncatePreview(inboundMessage.text)}`,
    );
    return { text, position };
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

  /**
   * Record control commands so a session can be reconstructed from the log.
   * Only the command word is kept, plus short arguments of navigation
   * commands; prompts and answers are never logged.
   */
  private logInboundCommand(text: string): void {
    const [word, ...rest] = text.trim().split(/\s+/);
    if (!word?.startsWith("/")) {
      return;
    }
    const command = word.toLowerCase();
    const argument = rest.join(" ");
    const keepsArgument = ["/cd", "/confirm", "/yes", "/deny", "/no", "/resume", "/model", "/lang", "/language", "/plan"]
      .includes(command);
    this.host.daemonLog(
      `inbound_command: ${command}${keepsArgument && argument ? ` ${truncatePreview(argument, 80)}` : ""}`,
    );
  }

  /** Reply for a switch that did not activate, naming the workspace. */
  private describeSwitchFailure(result: EnsureSlotResult): string {
    const slots = this.host.slotManager;
    if (result.refused) {
      const launcher = `${this.host.channelId}-${result.activeAdapter}`;
      const mode = slots.mode;
      return result.refused === "instance_mode_type_locked"
        ? t("daemon.refused.instanceLocked", {
          adapter: mode.kind === "multi_instance" ? mode.adapter : result.activeAdapter,
          target: result.activeAdapter,
          launcher,
        })
        : t("daemon.refused.typeOpen", { adapter: result.activeAdapter, launcher });
    }
    return t("daemon.activateFailed", {
      adapter: slots.sourceName(result.cwd, result.activeAdapter),
      detail: formatDaemonSwitchResultDetail(result),
    });
  }

  /**
   * `/open` opens another window of the current CLI in the current
   * directory; `/2` switches to that numbered window. Returns the message to
   * keep routing (a prompt after `/2`), null once handled, or undefined when
   * the text is neither command.
   */
  private async handleInstanceCommand(
    message: BridgeInboundMessage,
  ): Promise<BridgeInboundMessage | null | undefined> {
    const text = message.text.trim();
    const open = /^\/open$/i.test(text);
    const numbered = text.match(/^\/([1-9]\d?)(?:\s+([\s\S]+))?$/);
    if (!open && !numbered) {
      return undefined;
    }
    const slots = this.host.slotManager;
    const active = slots.getActiveSlot();
    if (!active) {
      await this.host.queueMessage(message.senderId, formatNoActiveAdapterMessage());
      return null;
    }
    const instance = numbered ? Number(numbered[1]) : undefined;
    if (instance !== undefined) {
      if (!modeAllowsCommand(slots.mode, "instance")) {
        await this.host.queueMessage(message.senderId, t("daemon.mode.instanceUnavailable"));
        return null;
      }
      if (!slots.getSlot(active.cwd, active.adapter, instance)) {
        await this.host.queueMessage(message.senderId, t("daemon.instance.notFound", {
          name: `${active.adapter}-${instance}`,
          list: slots.instancesOf(active.cwd, active.adapter).map((slot) => `/${slot.instance}`).join(", "),
        }));
        return null;
      }
    }
    const result = await slots.ensureSlot(active.adapter, {
      cwd: active.cwd,
      openVisible: true,
      reuseExistingVisible: true,
      ...(instance !== undefined ? { instance } : { newInstance: true }),
    });
    if (!result.activated) {
      await this.host.queueMessage(message.senderId, this.describeSwitchFailure(result));
      return null;
    }
    const slot = slots.getActiveSlot()!;
    this.bindCurrentConversation(slot);
    const remainder = numbered?.[2]?.trim();
    if (remainder) {
      return { ...message, text: remainder };
    }
    await this.host.queueMessage(message.senderId, t("daemon.activeTerminal", {
      adapter: slots.slotSourceName(slot),
      detail: formatDaemonSwitchResultDetail(result),
    }));
    return null;
  }

  async handleInboundMessage(message: BridgeInboundMessage): Promise<void> {
    if (message.senderId !== this.host.operatorId) {
      await this.host.queueMessage(
        message.senderId,
        t("bridge.unauthorized", { mode: t("bridge.mode.daemon"), operator: this.host.driver.operatorDescription }),
      );
      return;
    }

    this.logInboundCommand(message.text);

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
          await this.host.queueMessage(
            message.senderId,
            this.describeSwitchFailure(result),
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

    const afterInstanceCommand = await this.handleInstanceCommand(message);
    if (afterInstanceCommand === null) {
      return;
    }
    if (afterInstanceCommand) {
      message = afterInstanceCommand;
    }

    const switchDirective = parseDaemonSwitchDirective(message.text);
    if (switchDirective) {
      const result = await this.host.slotManager.ensureSlot(switchDirective.adapter, {
        openVisible: true,
        reuseExistingVisible: true,
      });
      if (!result.activated) {
        await this.host.queueMessage(message.senderId, this.describeSwitchFailure(result));
        return;
      }
      const detail = formatDaemonSwitchResultDetail(result);
      this.bindCurrentConversation(this.host.slotManager.getActiveSlot());
      if (switchDirective.remainder) {
        message = { ...message, text: switchDirective.remainder };
      } else {
        await this.host.queueMessage(
          message.senderId,
          t("daemon.activeTerminal", {
            adapter: this.host.slotManager.slotSourceName(this.host.slotManager.getActiveSlot()!),
            detail,
          }),
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

    const workspaceCommand = message.text.trim().match(/^\/cd(?:\s+([\s\S]+))?$/i);
    if (workspaceCommand) {
      if (!modeAllowsCommand(this.host.slotManager.mode, "cd")) {
        await this.host.queueMessage(
          message.senderId,
          t("daemon.mode.cdUnavailable", { launcher: `${this.host.channelId}-*` }),
        );
        return;
      }
      await this.host.controls.handleWorkspaceCommand(
        message.senderId,
        workspaceCommand[1]?.trim() ?? "",
      );
      return;
    }

    let slot = this.host.slotManager.getActiveSlot();
    if (!slot) {
      // Approvals and answers also work without a current terminal: the
      // request may be waiting in another workspace.
      const command = parseBridgeControlCommand(message.text);
      if (command && ["confirm", "deny", "answer"].includes(command.type)) {
        await this.host.controls.handleSystemCommand(message, null, command);
        return;
      }
      await this.host.queueMessage(message.senderId, formatNoActiveAdapterMessage());
      return;
    }
    this.bindCurrentConversation(slot);

    const routeCurrentMessage = async (
      currentSlot: DaemonSlot,
      command: ReturnType<typeof parseControlCommand>,
    ): Promise<void> => {
      const previousTask = currentSlot.turns.activeTask;
      await routeBridgeMessage({
        message: toChannelInboundMessage(message),
        authorized: true,
        command,
        adapterState: currentSlot.runtime.getState(),
        hasPendingApproval: currentSlot.pendingConfirmations.length > 0,
        hasPendingUserInput: Boolean(currentSlot.pendingUserInput),
        shouldDefer: shouldDeferCodexInboundMessage({
          adapter: currentSlot.adapter,
          status: currentSlot.runtime.getState().status,
          activeTurnOrigin: currentSlot.runtime.getState().activeTurnOrigin,
          hasPendingConfirmation: currentSlot.pendingConfirmations.length > 0,
          hasSystemCommand: Boolean(command),
        }),
        onUnauthorized: async () => undefined,
        handleCommand: async (nextCommand) => {
          await this.host.controls.handleSystemCommand(message, currentSlot, nextCommand);
          return true;
        },
        remindPendingApproval: async () => {
          await this.host.queueMessage(
            message.senderId,
            this.host.slotManager.prefix(
              currentSlot,
              formatPendingApprovalReminder(
                currentSlot.pendingConfirmations[0]!,
                currentSlot.runtime.getState(),
              ),
            ),
          );
          currentSlot.displayedApprovalRequestId = currentSlot.pendingConfirmations[0]?.requestId;
        },
        remindPendingUserInput: async () => {
          await this.host.queueMessage(
            message.senderId,
            this.host.slotManager.prefix(
              currentSlot,
              currentSlot.pendingUserInput
                ? formatPendingUserInputReminder(currentSlot.pendingUserInput, currentUserInputIndex(currentSlot))
                : t("bridge.input.waiting", { adapter: currentSlot.adapter }),
            ),
          );
        },
        remindBusy: async () => {
          await this.host.queueMessage(
            message.senderId,
            this.host.slotManager.prefix(
              currentSlot,
              t("bridge.busy.remote", { adapter: currentSlot.adapter }),
            ),
          );
        },
        defer: async () => {
          await this.deferInput(
            currentSlot,
            message,
            this.host.inboundConversationContext.get() ?? undefined,
          );
        },
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

    const command = parseControlCommand(message.text, {
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
        visibleResult.refused
          ? this.describeSwitchFailure(visibleResult)
          : this.host.slotManager.prefix(slot, formatDaemonSwitchResultDetail(visibleResult)),
      );
      return;
    }
    slot = this.host.slotManager.getActiveSlot() ?? slot;
    this.bindCurrentConversation(slot);
    await routeCurrentMessage(slot, null);
  }

  async dispatchInboundText(
    message: BridgeInboundMessage,
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
          this.host.slotManager.prefix(
            slot,
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
      this.host.typing.start(slot, message.senderId);
    }
    return dispatchResult;
  }

  async forwardInput(
    request: Extract<DaemonRequest, { command: "forward_input" }>,
  ): Promise<DaemonForwardInputResult> {
    if (!request.text.trim()) {
      throw new Error("forward_input requires non-empty text.");
    }
    const slots = this.host.slotManager;
    const cwd = request.cwd ?? slots.activeCwd;
    // Input for another workspace runs there without moving the channel's
    // current workspace.
    const activate = slots.isActiveWorkspace(cwd);
    const adapter = request.adapter ?? (activate ? slots.activeAdapter : null);
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

    const previousActiveAdapter = slots.activeAdapter;
    const ensureResult = await slots.ensureSlot(adapter, {
      cwd,
      activate,
      openVisible: true,
      reuseExistingVisible: true,
    });
    if (!ensureResult.activated) {
      return {
        forwarded: false,
        adapter,
        conversationId,
        reason: "not_activated",
        message: ensureResult.refused
          ? this.describeSwitchFailure(ensureResult)
          : formatDaemonSwitchResultDetail(ensureResult),
      };
    }
    const slot = slots.getSlot(cwd, adapter);
    if (!slot) {
      throw new Error(`Adapter slot ${adapter} is not available.`);
    }

    const inboundMessage: BridgeInboundMessage = {
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
      const routed = await slots.serializeSlotInput(slot, () =>
        this.host.inboundConversationContext.run(conversation, () =>
          this.routeDaemonInput(slot, inboundMessage, conversation),
        ));
      if (routed.kind === "dispatched") {
        return { forwarded: true, adapter, conversationId };
      }
      slots.restoreActiveAdapterAfterRejectedInput(
        adapter,
        ensureResult.activationVersion,
        previousActiveAdapter,
        ensureResult.previousActiveCwd,
        ensureResult.previousActiveInstance,
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
      slots.restoreActiveAdapterAfterRejectedInput(
        adapter,
        ensureResult.activationVersion,
        previousActiveAdapter,
        ensureResult.previousActiveCwd,
        ensureResult.previousActiveInstance,
      );
      throw error;
    }
  }
}
