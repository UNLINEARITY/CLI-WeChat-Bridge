// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { delay } from "../bridge/bridge-adapters.shared.ts";
import type { BridgeEvent } from "../bridge/bridge-types.ts";
import {
  formatApprovalMessage,
  formatMirroredUserInputMessage,
  formatSessionSwitchMessage,
  formatTaskFailedMessage,
  formatUserInputRequestMessage,
  nowIso,
  truncatePreview,
} from "../bridge/bridge-utils.ts";
import { shouldForwardSessionSwitchEvent } from "../bridge/bridge-session-resume.ts";
import {
  formatUserFacingBridgeFatalError,
  shouldForwardBridgeEventToWechat,
  shouldSuppressCodexLocalThreadNotice,
  type WechatSendContext,
} from "../channels/wechat/wechat-forwarding.ts";
import { forwardBridgeEvent } from "../core/bridge-event-forwarder.ts";
import type { ChannelRuntime } from "../channels/channel-registry.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type {
  BridgeChannelPort,
  ChannelConversationRef,
  ChannelOutputKind,
} from "../core/channel-types.ts";
import { log, logError } from "./daemon-shared.ts";
import type { OutboundDispatcher } from "../core/outbound-dispatcher.ts";
import {
  type DaemonSlot,
  toPendingApproval,
  toPendingUserInput,
} from "./daemon-slot.ts";

const FATAL_NOTICE_GRACE_MS = 1_000;

function toWechatSendContext(kind: ChannelOutputKind): WechatSendContext {
  if (kind === "mirrored_input") {
    return "mirrored_user_input";
  }
  if (kind === "status") {
    return "message";
  }
  return kind;
}

export type SlotEventHost = {
  channel: ChannelRuntime;
  driver: ChannelDriver;
  operatorId: string;
  fallbackConversation: ChannelConversationRef;
  outbound: OutboundDispatcher;
  queueMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  resolveSlotOutputTarget: (slot: DaemonSlot) => ChannelConversationRef;
  maybeDrainDeferredInputs: (slot: DaemonSlot) => Promise<void>;
  disposeDeadSlot: (slot: DaemonSlot) => void;
  releaseSlot: (slot: DaemonSlot) => void;
  /** Persist the session the slot now follows. */
  syncSession: (slot: DaemonSlot) => void;
  /** True once the daemon has started shutting down. */
  isShuttingDown: () => boolean;
  /** Wait before reporting a fatal error, to tell it apart from shutdown. */
  fatalNoticeGraceMs?: number;
  /** Source prefix for slot output (`[adapter]` or `[workspace/adapter]`). */
  prefix: (slot: DaemonSlot, text: string) => string;
  daemonLog: (message: string) => void;
};

function createSlotChannelPort(host: SlotEventHost, slot: DaemonSlot): BridgeChannelPort {
  const adapter = slot.adapter;
  return host.channel.createPort({
    sendTextToTarget: (target, text, kind) =>
      host.queueMessage(
        host.operatorId,
        text,
        toWechatSendContext(kind),
        target,
      ),
    sendTextToRecipient: (recipientId, text, context) =>
      host.queueMessage(recipientId, text, context as WechatSendContext),
    queueAttachment: (action) => host.outbound.queueAttachment(action),
    prefixText: (_currentAdapter, text) => host.prefix(slot, text),
    onEmptyVisibleReply: (currentAdapter, rawText) => {
      host.daemonLog(
        `empty_visible_final_reply: adapter=${currentAdapter ?? adapter} raw=${truncatePreview(rawText)}`,
      );
    },
    onTextSent: (currentAdapter, text) => {
      host.daemonLog(
        `final_reply_sent: adapter=${currentAdapter ?? adapter} chars=${Array.from(text).length}`,
      );
    },
  });
}

/** Forward one adapter event from a daemon slot to the channel. */
export function handleSlotEvent(host: SlotEventHost, slot: DaemonSlot, event: BridgeEvent): void {
  slot.controller.syncLocalClientEndpoint();
  host.syncSession(slot);
  const adapterState = slot.runtime.getState();
  const channelPort = createSlotChannelPort(host, slot);
  const eventTarget = host.driver.capabilities.multiConversation
    ? host.resolveSlotOutputTarget(slot)
    : host.fallbackConversation;
  const eventTask = slot.turns.activeTask;
  if (adapterState.pendingApprovals !== undefined) {
    const previous = new Map(slot.pendingConfirmations.map((pending) => [pending.requestId, pending]));
    slot.pendingConfirmations = adapterState.pendingApprovals.map((request) => {
      const existing = previous.get(request.requestId);
      return existing ? { ...existing, ...request } : toPendingApproval({ type: "approval_required", request, timestamp: nowIso() });
    });
  }
  if (slot.pendingConfirmations.length > 0 && !adapterState.pendingApproval) {
    slot.pendingConfirmations = [];
  }
  if (slot.pendingUserInput && (!adapterState.pendingUserInput
    || (slot.pendingUserInput.requestId !== undefined && slot.pendingUserInput.requestId !== adapterState.pendingUserInput.requestId))) {
    slot.pendingUserInput = null;
  }

  slot.eventForwardChain = slot.eventForwardChain
    .then(() => forwardBridgeEvent(event, {
    stdout: (next) => {
      slot.lastOutputAt = Date.now();
      if (shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
        slot.outputBatcher.push(next.text);
      }
    },
    stderr: (next) => {
      slot.lastOutputAt = Date.now();
      if (shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
        slot.outputBatcher.push(next.text);
      }
    },
    finalReply: (next) => {
      void host.driver.endTyping?.(host.operatorId);
      slot.lastFinalReplyAtMs = Date.now();
      host.daemonLog(`final_reply: adapter=${slot.adapter} text=${truncatePreview(next.text)}`);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        await channelPort.send({
          target: eventTarget,
          kind: "final_reply",
          text: next.text,
          adapter: slot.adapter,
        });
      }));
    },
    status: (next) => {
      if (next.message) {
        log(`${slot.adapter} ${next.status}: ${next.message}`);
        host.daemonLog(`${slot.adapter}_${next.status}: ${next.message}`);
      }
    },
    notice: (next) => {
      slot.lastOutputAt = Date.now();
      host.daemonLog(`${slot.adapter}_${next.level}_notice: ${truncatePreview(next.text)}`);
      if (shouldForwardBridgeEventToWechat(slot.adapter, next.type, { text: next.text })) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, next.text), "notice", eventTarget);
        }));
      }
    },
    approvalRequired: (next) => {
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        const liveState = slot.runtime.getState();
        if (liveState.pendingApprovals !== undefined && liveState.pendingApproval?.requestId !== next.request.requestId) return;
        const pending = toPendingApproval(next);
        if (liveState.pendingApprovals === undefined) {
          slot.pendingConfirmations = [pending];
        }
        host.daemonLog(`approval_required: adapter=${slot.adapter} source=${pending.source} command=${truncatePreview(pending.commandPreview)}`);
        await host.queueMessage(host.operatorId, host.prefix(slot, formatApprovalMessage(pending, liveState)), "approval_required", eventTarget);
        if (slot.runtime.getState().pendingApproval?.requestId === pending.requestId) {
          slot.displayedApprovalRequestId = pending.requestId;
        }
      }));
    },
    userInputRequired: (next) => {
      if (next.request.requestId !== undefined && slot.runtime.getState().pendingUserInput?.requestId !== next.request.requestId) return;
      const pending = toPendingUserInput(next.request);
      slot.pendingUserInput = pending;
      host.daemonLog(`user_input_required: adapter=${slot.adapter} questions=${pending.questions.length}`);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        if (pending.requestId !== undefined && slot.runtime.getState().pendingUserInput?.requestId !== pending.requestId) return;
        await host.queueMessage(host.operatorId, host.prefix(slot, formatUserInputRequestMessage(pending, adapterState)), "user_input_required", eventTarget);
      }));
    },
    mirroredUserInput: (next) => {
      host.daemonLog(`mirrored_local_input: adapter=${slot.adapter} text=${truncatePreview(next.text)}`);
      if (shouldForwardBridgeEventToWechat(slot.adapter, next.type, { text: next.text })) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, formatMirroredUserInputMessage(slot.adapter, next.text)), "mirrored_user_input", eventTarget);
        }));
      }
    },
    sessionSwitched: (next) => {
      if (next.source === "local") slot.resumeCoordinator.clear();
      host.daemonLog(`session_switched: adapter=${slot.adapter} session=${next.sessionId} source=${next.source} reason=${next.reason}`);
      if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, formatSessionSwitchMessage({ adapter: slot.adapter, sessionId: next.sessionId, source: next.source, reason: next.reason })), "session_switched", eventTarget);
        }));
      }
    },
    threadSwitched: (next) => {
      if (next.source === "local") slot.resumeCoordinator.clear();
      host.daemonLog(`thread_switched: adapter=${slot.adapter} thread=${next.threadId} source=${next.source} reason=${next.reason}`);
      // The first thread is the one a new visible window opens; switching
      // into it is not news to the operator.
      const firstThread = slot.knownThreadId === undefined;
      slot.knownThreadId = next.threadId;
      if (
        firstThread ||
        shouldSuppressCodexLocalThreadNotice({
          adapter: slot.adapter,
          source: next.source,
          activeTurnOrigin: slot.runtime.getState().activeTurnOrigin,
          lastFinalReplyAtMs: slot.lastFinalReplyAtMs,
        })
      ) {
        return;
      }
      if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEventToWechat(slot.adapter, next.type)) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, formatSessionSwitchMessage({ adapter: slot.adapter, sessionId: next.threadId, source: next.source, reason: next.reason })), "thread_switched", eventTarget);
        }));
      }
    },
    taskComplete: () => {
      void host.driver.endTyping?.(host.operatorId);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(() => {
        slot.pendingConfirmations = [];
        slot.pendingUserInput = null;
        if (eventTask) {
          slot.turns.complete(eventTask);
        }
        void host.maybeDrainDeferredInputs(slot);
      }));
    },
    taskFailed: (next) => {
      void host.driver.endTyping?.(host.operatorId);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        slot.pendingConfirmations = [];
        slot.pendingUserInput = null;
        if (eventTask) {
          slot.turns.complete(eventTask);
        }
        void host.maybeDrainDeferredInputs(slot);
        await host.queueMessage(host.operatorId, host.prefix(slot, formatTaskFailedMessage(slot.adapter, next.message)), "task_failed", eventTarget);
      }));
    },
    fatalError: (next) => {
      void host.driver.endTyping?.(host.operatorId);
      logError(`${slot.adapter}: ${next.message}`);
      host.daemonLog(`fatal_error: adapter=${slot.adapter} message=${next.message}`);
      slot.pendingConfirmations = [];
      slot.pendingUserInput = null;
      if (eventTask) {
        slot.turns.complete(eventTask);
      }
      void host.maybeDrainDeferredInputs(slot);
      host.disposeDeadSlot(slot);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        // Closing the daemon's terminal ends its CLI children a moment before
        // the daemon sees the signal; those exits are not errors to report.
        await delay(host.fatalNoticeGraceMs ?? FATAL_NOTICE_GRACE_MS);
        if (host.isShuttingDown()) {
          host.daemonLog(`fatal_error_notice_skipped: adapter=${slot.adapter} reason=shutdown`);
          return;
        }
        await host.queueMessage(host.operatorId, host.prefix(slot, formatUserFacingBridgeFatalError(next.message)), "fatal_error", eventTarget);
      }));
    },
    shutdownRequested: (next) => {
      host.daemonLog(`slot_shutdown_requested: adapter=${slot.adapter} reason=${next.reason}`);
      // A window-bound slot ends with its visible window.
      if (slot.boundToWindow) {
        host.releaseSlot(slot);
      }
    },
    }))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      host.daemonLog(`event_forward_failed: adapter=${slot.adapter} message=${message}`);
    });
}
