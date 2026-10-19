// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import { handleLanguageControl } from "../bridge/language-control.ts";
import { LANGUAGE_FILE } from "../wechat/channel-config.ts";
import {
  nowIso,
  parsePendingUserInputAnswerCommand,
  parseWechatControlCommand,
  truncatePreview,
} from "../bridge/bridge-utils.ts";
import { isWechatResumeEnabled } from "../bridge/bridge-session-resume.ts";
import type { WechatSendContext } from "../channels/wechat/wechat-forwarding.ts";
import {
  formatBindingsListMessage,
  listBindings,
  removeBinding,
  setBinding,
  type EmojiBindingsCommand,
} from "./emoji-bindings.ts";
import type { InboundWechatMessage } from "../wechat/wechat-transport.ts";
import { handleAdapterControl } from "../bridge/adapter-control.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type { ChannelConversationRef } from "../core/channel-types.ts";
import type { DaemonAdapterKind, DaemonStatus } from "./daemon-link.ts";
import { DAEMON_ADAPTERS } from "./daemon-shared.ts";
import { formatDaemonSwitchResultDetail, formatDaemonStatus } from "./daemon-commands.ts";
import {
  type DaemonSlot,
  type EnsureSlotOptions,
  type EnsureSlotResult,
  toPendingApproval,
  prefixDaemonAdapterMessage,
} from "./daemon-slot.ts";

export type ControlCommandHost = {
  driver: ChannelDriver;
  localeSettingsFile?: string;
  slots: () => Map<DaemonAdapterKind, DaemonSlot>;
  queueMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  getStatus: () => DaemonStatus;
  ensureSlot: (adapter: DaemonAdapterKind, options?: EnsureSlotOptions) => Promise<EnsureSlotResult>;
  dispatchInboundText: (message: InboundWechatMessage, slot: DaemonSlot) => Promise<unknown>;
  daemonLog: (message: string) => void;
};

/** Daemon control commands: system commands, approvals, answers, broadcast, bindings. */
export class DaemonControlCommands {
  private readonly host: ControlCommandHost;

  constructor(host: ControlCommandHost) {
    this.host = host;
  }

  async handleEmojiBindingsCommand(
    senderId: string,
    cmd: EmojiBindingsCommand,
  ): Promise<void> {
    switch (cmd.type) {
      case "list": {
        await this.host.queueMessage(senderId, formatBindingsListMessage(listBindings()));
        return;
      }
      case "bind": {
        setBinding(cmd.emoji, cmd.command);
        await this.host.queueMessage(
          senderId,
          t("binding.bound", { emoji: cmd.emoji, command: cmd.command }),
        );
        return;
      }
      case "unbind": {
        const removed = removeBinding(cmd.emoji);
        await this.host.queueMessage(
          senderId,
          removed
            ? t("binding.unbound", { emoji: cmd.emoji })
            : t("binding.notFound", { emoji: cmd.emoji }),
        );
        return;
      }
    }
  }

  async handleSystemCommand(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    command: NonNullable<ReturnType<typeof parseWechatControlCommand>>,
  ): Promise<void> {
    switch (command.type) {
      case "language":
        await this.handleLanguageCommand(message.senderId, command.target);
        return;
      case "model":
      case "plan":
        await this.host.queueMessage(message.senderId, await handleAdapterControl(activeSlot.runtime, message.senderId, command));
        return;
      case "status":
        await this.host.queueMessage(
          message.senderId,
          formatDaemonStatus(this.host.getStatus()),
        );
        return;
      case "resume": {
        if (!isWechatResumeEnabled(activeSlot.adapter)) {
          await this.host.queueMessage(
            message.senderId,
            t("daemon.resume.disabled", { channel: this.host.driver.displayName, adapter: activeSlot.adapter }),
          );
          return;
        }
        try {
          let resumeSlot = activeSlot;
          if (activeSlot.adapter === "codex" && command.target) {
            const visible = await this.host.ensureSlot("codex", {
              openVisible: true,
              reuseExistingVisible: true,
            });
            if (!visible.activated) {
              throw new Error(formatDaemonSwitchResultDetail(visible));
            }
            resumeSlot = this.host.slots().get("codex") ?? activeSlot;
          }
          if (command.target) {
            await resumeSlot.outputBatcher.flushNow();
          }
          const taskBeforeResume = resumeSlot.turns.activeTask;
          const result = await resumeSlot.resumeCoordinator.execute(command.target);
          if (result.kind === "resumed" && taskBeforeResume) {
            resumeSlot.turns.complete(taskBeforeResume);
          }
          await this.host.queueMessage(
            message.senderId,
            prefixDaemonAdapterMessage(resumeSlot.adapter, result.message),
          );
        } catch (error) {
          await this.host.queueMessage(
            message.senderId,
            prefixDaemonAdapterMessage(
              activeSlot.adapter,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        return;
      }
      case "new_session":
        if (!activeSlot.runtime.createSession) {
          await this.host.queueMessage(
            message.senderId,
            t("bridge.newSession.unavailable", { adapter: activeSlot.adapter }),
          );
          return;
        }
        await activeSlot.outputBatcher.flushNow();
        activeSlot.outputBatcher.clear();
        activeSlot.pendingConfirmations = [];
        activeSlot.pendingUserInput = null;
        activeSlot.resumeCoordinator.clear();
        await activeSlot.runtime.createSession();
        this.host.daemonLog(`new_session: adapter=${activeSlot.adapter}`);
        return;
      case "broadcast":
        await this.handleBroadcastCommand(message, command.text);
        return;
      case "stop": {
        const interrupted = await activeSlot.runtime.interrupt();
        await this.host.queueMessage(
          message.senderId,
          prefixDaemonAdapterMessage(
            activeSlot.adapter,
            interrupted
              ? t("bridge.interrupt.workerSent")
              : t("bridge.interrupt.workerIdle"),
          ),
        );
        return;
      }
      case "reset":
        await activeSlot.outputBatcher.flushNow();
        activeSlot.outputBatcher.clear();
        activeSlot.pendingConfirmations = [];
        activeSlot.pendingUserInput = null;
        activeSlot.resumeCoordinator.clear();
        await activeSlot.runtime.reset();
        this.host.daemonLog(`reset: adapter=${activeSlot.adapter}`);
        await this.host.queueMessage(
          message.senderId,
          prefixDaemonAdapterMessage(activeSlot.adapter, t("bridge.reset.done")),
        );
        return;
      case "confirm":
        await this.confirmPendingApproval(message, activeSlot);
        return;
      case "deny":
        await this.denyPendingApproval(message, activeSlot);
        return;
      case "answer":
        await this.answerPendingUserInput(message, activeSlot, command.raw);
        return;
    }
  }

  async handleLanguageCommand(senderId: string, target?: string): Promise<void> {
    await this.host.queueMessage(senderId, await handleLanguageControl({
      target,
      settingsFile: this.host.localeSettingsFile ?? LANGUAGE_FILE,
      adapters: [...this.host.slots().values()].map((slot) => slot.runtime),
    }));
  }

  async confirmPendingApproval(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
  ): Promise<void> {
    const slot = this.resolvePendingApprovalSlot(activeSlot);
    if (!slot || slot.pendingConfirmations.length === 0) {
      await this.host.queueMessage(message.senderId, t("approval.noPending"));
      return;
    }

    const pending = slot.pendingConfirmations[0]!;
    const count = await slot.runtime.resolveApproval("confirm", slot.runtime.getState().pendingApprovals !== undefined ? slot.displayedApprovalRequestId ?? "" : pending.requestId) ? 1 : 0;
    if (!count) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          t("bridge.approval.applyFailed"),
        ),
      );
      return;
    }
    const preview = pending.commandPreview;
    const adapterState = slot.runtime.getState();
    slot.pendingConfirmations = (adapterState.pendingApprovals ?? (adapterState.pendingApproval ? [adapterState.pendingApproval] : []))
      .map((request) => toPendingApproval({ type: "approval_required", request, timestamp: nowIso() }));
    this.host.daemonLog(
      `approval_confirmed: adapter=${slot.adapter} count=${count} command=${truncatePreview(preview)}`,
    );
    await this.host.queueMessage(
      message.senderId,
      prefixDaemonAdapterMessage(
        slot.adapter,
        t("approval.confirmed"),
      ),
    );
  }

  async denyPendingApproval(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
  ): Promise<void> {
    const slot = this.resolvePendingApprovalSlot(activeSlot);
    if (!slot || slot.pendingConfirmations.length === 0) {
      await this.host.queueMessage(message.senderId, t("approval.noPending"));
      return;
    }

    const pending = slot.pendingConfirmations[0]!;
    const count = await slot.runtime.resolveApproval("deny", slot.runtime.getState().pendingApprovals !== undefined ? slot.displayedApprovalRequestId ?? "" : pending.requestId) ? 1 : 0;
    if (!count) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          t("bridge.approval.denyFailed"),
        ),
      );
      return;
    }
    const adapterState = slot.runtime.getState();
    slot.pendingConfirmations = (adapterState.pendingApprovals ?? (adapterState.pendingApproval ? [adapterState.pendingApproval] : []))
      .map((request) => toPendingApproval({ type: "approval_required", request, timestamp: nowIso() }));
    this.host.daemonLog(
      `approval_denied: adapter=${slot.adapter} count=${count}`,
    );
    await this.host.queueMessage(
      message.senderId,
      prefixDaemonAdapterMessage(
        slot.adapter,
        t("approval.denied"),
      ),
    );
  }

  async answerPendingUserInput(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    raw: string,
  ): Promise<void> {
    // Mirror the /confirm and /deny behavior: search every slot for a pending
    // user-input request so the answer reaches the adapter that asked, even
    // when the user has since switched the active adapter.
    const slot = this.resolvePendingUserInputSlot(activeSlot);
    if (!slot) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(activeSlot.adapter, t("bridge.answer.none")),
      );
      return;
    }

    const pending = slot.pendingUserInput;
    if (!pending) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(activeSlot.adapter, t("bridge.answer.none")),
      );
      return;
    }

    const parsed = parsePendingUserInputAnswerCommand(raw, pending);
    if ("error" in parsed) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(slot.adapter, parsed.error),
      );
      return;
    }

    const submitted = await slot.runtime.submitUserInput(parsed.answers, pending.requestId);
    if (!submitted) {
      await this.host.queueMessage(
        message.senderId,
        prefixDaemonAdapterMessage(
          slot.adapter,
          t("bridge.answer.failed"),
        ),
      );
      return;
    }

    if (slot.pendingUserInput?.requestId === pending.requestId) slot.pendingUserInput = null;
    this.host.daemonLog(
      `user_input_answered: adapter=${slot.adapter} preview=${parsed.preview}`,
    );
    await this.host.queueMessage(
      message.senderId,
      prefixDaemonAdapterMessage(slot.adapter, t("bridge.answer.sent")),
    );
  }

  private resolvePendingUserInputSlot(
    activeSlot: DaemonSlot,
  ): DaemonSlot | null {
    if (activeSlot.pendingUserInput) {
      return activeSlot;
    }

    return (
      Array.from(this.host.slots().values()).find(
        (slot) => slot.pendingUserInput !== null,
      ) ?? null
    );
  }

  private resolvePendingApprovalSlot(
    activeSlot: DaemonSlot,
  ): DaemonSlot | null {
    if (activeSlot.pendingConfirmations.length > 0) {
      return activeSlot;
    }

    return (
      Array.from(this.host.slots().values()).find(
        (slot) => slot.pendingConfirmations.length > 0,
      ) ?? null
    );
  }

  private isSlotBusyForBroadcast(slot: DaemonSlot): boolean {
    const state = slot.runtime.getState();
    if (slot.turns.hasActiveTask) return true;
    if (slot.pendingConfirmations.length > 0 || slot.pendingUserInput) return true;
    if (slot.deferredInputs.length > 0) return true;
    if (state.status === "busy" || state.status === "awaiting_approval" || state.status === "awaiting_input") {
      return true;
    }
    return false;
  }

  private async handleBroadcastCommand(
    message: InboundWechatMessage,
    text: string,
  ): Promise<void> {
    const startedSlots = DAEMON_ADAPTERS
      .map((adapter) => this.host.slots().get(adapter))
      .filter((slot): slot is DaemonSlot => Boolean(slot));
    if (startedSlots.length === 0) {
      await this.host.queueMessage(
        message.senderId,
        t("daemon.broadcast.empty"),
      );
      return;
    }

    const busySlots = startedSlots.filter((slot) => this.isSlotBusyForBroadcast(slot));
    if (busySlots.length > 0) {
      const names = busySlots.map((slot) => slot.adapter).join(", ");
      this.host.daemonLog(`broadcast_canceled_busy: busy=[${names}]`);
      await this.host.queueMessage(
        message.senderId,
        t("daemon.broadcast.busy", { workers: t(busySlots.length > 1 ? "daemon.broadcast.multipleBusy" : "daemon.broadcast.singleBusy"), names }),
      );
      return;
    }

    const broadcastMessage: InboundWechatMessage = { ...message, text };
    const dispatched: string[] = [];
    const skipped: string[] = [];
    for (const adapter of DAEMON_ADAPTERS) {
      const slot = this.host.slots().get(adapter);
      if (!slot) {
        skipped.push(adapter);
        continue;
      }
      this.host.daemonLog(`broadcast_input: adapter=${adapter} text=${truncatePreview(text)}`);
      await this.host.dispatchInboundText(broadcastMessage, slot);
      dispatched.push(adapter);
    }

    const lines = [
      t("daemon.broadcast.sent", { count: dispatched.length, workers: t(dispatched.length > 1 ? "daemon.broadcast.multipleWorkers" : "daemon.broadcast.singleWorker"), names: dispatched.join(", ") }),
    ];
    if (skipped.length > 0) {
      lines.push(t("daemon.broadcast.skipped", { names: skipped.join(", ") }));
    }
    await this.host.queueMessage(message.senderId, lines.join("\n"));
  }
}
