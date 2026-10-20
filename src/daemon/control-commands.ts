// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import { t } from "../i18n/index.ts";
import { handleLanguageControl } from "../bridge/language-control.ts";
import { LANGUAGE_FILE } from "../wechat/channel-config.ts";
import { nowIso, parseControlCommand, truncatePreview } from "../bridge/bridge-utils.ts";
import {
  formatUserInputAnswerPreview,
  formatUserInputQuestionMessage,
  isKeyedUserInputAnswer,
  parsePendingUserInputAnswerCommand,
  parseUserInputQuestionAnswer,
} from "../bridge/user-input-messages.ts";
import { formatApprovalMessage } from "../bridge/message-formatting.ts";
import type { ApprovalDecision, PendingUserInputRequest } from "../bridge/bridge-types.ts";
import { isAutoApprovalEnabled, setAutoApprovalOverride } from "../bridge/approval-policy.ts";
import { isRemoteResumeEnabled } from "../bridge/bridge-session-resume.ts";
import type { ChannelSendKind } from "../channels/wechat/wechat-forwarding.ts";
import {
  formatBindingsListMessage,
  listBindings,
  removeBinding,
  setBinding,
  type EmojiBindingsCommand,
} from "./emoji-bindings.ts";
import type { BridgeInboundMessage } from "../core/channel-types.ts";
import { handleAdapterControl } from "../bridge/adapter-control.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type { ChannelConversationRef } from "../core/channel-types.ts";
import type { DaemonAdapterKind, DaemonStatus } from "./daemon-link.ts";
import { DAEMON_ADAPTERS } from "./daemon-shared.ts";
import {
  formatDaemonStatus,
  formatDaemonSwitchResultDetail,
  formatNoActiveAdapterMessage,
} from "./daemon-commands.ts";
import type { SlotManager } from "./slot-manager.ts";
import { modeAllowsCommand } from "./bridge-mode.ts";
import {
  type DaemonSlot,
  type EnsureSlotOptions,
  type EnsureSlotResult,
  toPendingApproval,
  slotName,
} from "./daemon-slot.ts";

export type ControlCommandHost = {
  driver: ChannelDriver;
  localeSettingsFile?: string;
  slotManager: SlotManager;
  queueMessage: (
    senderId: string,
    text: string,
    context?: ChannelSendKind,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  getStatus: () => DaemonStatus;
  ensureSlot: (adapter: DaemonAdapterKind, options?: EnsureSlotOptions) => Promise<EnsureSlotResult>;
  dispatchInboundText: (message: BridgeInboundMessage, slot: DaemonSlot) => Promise<unknown>;
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
    message: BridgeInboundMessage,
    activeSlot: DaemonSlot | null,
    command: NonNullable<ReturnType<typeof parseControlCommand>>,
  ): Promise<void> {
    switch (command.type) {
      case "language":
        await this.handleLanguageCommand(message.senderId, command.target);
        return;
      case "status":
        await this.host.queueMessage(
          message.senderId,
          formatDaemonStatus(this.host.getStatus()),
        );
        return;
      case "broadcast":
        await this.handleBroadcastCommand(message, command.text);
        return;
      case "auto":
        await this.handleAutoApprovalCommand(message.senderId, command);
        return;
      case "confirm":
        await this.confirmPendingApproval(message, activeSlot, command.index);
        return;
      case "always":
        await this.resolveApproval("always", message, activeSlot, command.index);
        return;
      case "deny":
        await this.denyPendingApproval(message, activeSlot, command.index, command.reason);
        return;
      case "abort":
        await this.resolveApproval("abort", message, activeSlot, command.index);
        return;
      case "answer":
        await this.answerPendingUserInput(message, activeSlot, command.raw);
        return;
    }
    if (!activeSlot) {
      await this.host.queueMessage(message.senderId, formatNoActiveAdapterMessage());
      return;
    }
    switch (command.type) {
      case "model":
      case "plan":
        await this.host.queueMessage(message.senderId, await handleAdapterControl(activeSlot.runtime, message.senderId, command));
        return;
      case "resume": {
        if (!isRemoteResumeEnabled(activeSlot.adapter)) {
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
            resumeSlot = this.host.slotManager.getSlot(activeSlot.cwd, "codex") ?? activeSlot;
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
            this.host.slotManager.prefix(resumeSlot, result.message),
          );
        } catch (error) {
          await this.host.queueMessage(
            message.senderId,
            this.host.slotManager.prefix(
              activeSlot,
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
      case "stop": {
        const interrupted = await activeSlot.runtime.interrupt();
        await this.host.queueMessage(
          message.senderId,
          this.host.slotManager.prefix(
            activeSlot,
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
          this.host.slotManager.prefix(activeSlot, t("bridge.reset.done")),
        );
        return;
    }
  }

  async handleLanguageCommand(senderId: string, target?: string): Promise<void> {
    await this.host.queueMessage(senderId, await handleLanguageControl({
      target,
      settingsFile: this.host.localeSettingsFile ?? LANGUAGE_FILE,
      adapters: this.host.slotManager.allSlots().map((slot) => slot.runtime),
    }));
  }

  /** `/cd` lists the workspaces; `/cd <number|name>` switches to one. */
  async handleWorkspaceCommand(senderId: string, target: string): Promise<void> {
    const slots = this.host.slotManager;
    const workspaces = slots.workspaces();
    if (!target) {
      await this.host.queueMessage(senderId, this.formatWorkspaceList(workspaces));
      return;
    }
    let match: string | undefined;
    if (/^\d+$/.test(target)) {
      match = workspaces[Number(target) - 1];
    } else {
      const named = workspaces.filter((cwd) =>
        slots.workspaceLabel(cwd) === target || path.basename(cwd) === target);
      if (named.length > 1) {
        await this.host.queueMessage(senderId, t("daemon.cd.ambiguous", { target }));
        return;
      }
      match = named[0];
    }
    if (!match) {
      await this.host.queueMessage(
        senderId,
        `${t("daemon.cd.notFound", { target })}\n\n${this.formatWorkspaceList(workspaces)}`,
      );
      return;
    }
    const slot = slots.switchWorkspace(match);
    this.host.daemonLog(`workspace_switched: cwd=${match} adapter=${slot?.adapter ?? "(none)"}`);
    await this.host.queueMessage(senderId, t("daemon.cd.switched", {
      label: slots.workspaceLabel(match),
      cwd: match,
      adapter: slot?.adapter ?? t("status.none"),
    }));
  }

  private formatWorkspaceList(workspaces: string[]): string {
    const slots = this.host.slotManager;
    const list = workspaces.map((cwd, index) => {
      const adapters = slots.slotsIn(cwd)
        .map((slot) => `${slotName(slot)}${slot.attached ? t("daemon.cd.attached") : ""}`)
        .join(", ");
      return t("daemon.cd.item", {
        index: index + 1,
        label: slots.workspaceLabel(cwd),
        adapters: adapters || t("daemon.cd.none"),
        current: slots.isActiveWorkspace(cwd) ? t("daemon.cd.current") : "",
      });
    });
    return t("daemon.cd.list", { list: list.join("\n") });
  }

  /** `workspace/adapter`, as shown in cross-workspace lists. */
  private sourceOf(slot: DaemonSlot): string {
    return `${this.host.slotManager.workspaceLabel(slot.cwd)}/${slot.adapter}`;
  }

  /** Slots matching a predicate, ordered by workspace list then adapter. */
  private slotsWhere(predicate: (slot: DaemonSlot) => boolean): DaemonSlot[] {
    const slots = this.host.slotManager;
    return slots.workspaces().flatMap((cwd) => slots.slotsIn(cwd)).filter(predicate);
  }

  /**
   * The approval target: the numbered entry when an index is given,
   * otherwise the current slot. Replies with the numbered list when the
   * current slot has nothing pending but other slots do.
   */
  private async resolveApprovalTarget(
    senderId: string,
    activeSlot: DaemonSlot | null,
    index: number | undefined,
  ): Promise<DaemonSlot | null> {
    const pending = this.slotsWhere((slot) => slot.pendingConfirmations.length > 0);
    if (index !== undefined) {
      const target = pending[index - 1];
      if (!target) {
        await this.host.queueMessage(senderId, t("daemon.approval.badIndex", { index }));
      }
      return target ?? null;
    }
    if (activeSlot && activeSlot.pendingConfirmations.length > 0) {
      return activeSlot;
    }
    if (pending.length === 0) {
      await this.host.queueMessage(senderId, t("approval.noPending"));
      return null;
    }
    const list = pending.map((slot, i) => t("daemon.approval.item", {
      index: i + 1,
      source: this.sourceOf(slot),
      summary: slot.pendingConfirmations[0]!.commandPreview,
    }));
    await this.host.queueMessage(
      senderId,
      t("daemon.approval.pendingElsewhere", { list: list.join("\n") }),
    );
    return null;
  }

  /** `/auto on|off` switches auto-approval for every window until the daemon exits. */
  private async handleAutoApprovalCommand(
    senderId: string,
    command: { enabled?: boolean; invalid?: boolean },
  ): Promise<void> {
    if (command.invalid) {
      await this.host.queueMessage(senderId, t("approval.auto.usage"));
      return;
    }
    if (command.enabled === undefined) {
      await this.host.queueMessage(senderId, t(isAutoApprovalEnabled() ? "approval.auto.statusOn" : "approval.auto.statusOff"));
      return;
    }
    setAutoApprovalOverride(command.enabled);
    const results = await Promise.allSettled(
      this.slotsWhere(() => true).map((slot) => slot.runtime.setAutoApproval?.(command.enabled!) ?? true),
    );
    const needsRestart = results.some((result) => result.status === "rejected" || result.value === false);
    this.host.daemonLog(`auto_approval: enabled=${command.enabled} needs_restart=${needsRestart}`);
    await this.host.queueMessage(
      senderId,
      t(command.enabled ? "approval.auto.enabled" : "approval.auto.disabled")
        + (needsRestart ? `\n${t("approval.auto.companionRestart")}` : ""),
    );
  }

  async confirmPendingApproval(
    message: BridgeInboundMessage,
    activeSlot: DaemonSlot | null,
    index?: number,
  ): Promise<void> {
    await this.resolveApproval("confirm", message, activeSlot, index);
  }

  async denyPendingApproval(
    message: BridgeInboundMessage,
    activeSlot: DaemonSlot | null,
    index?: number,
    reason?: string,
  ): Promise<void> {
    await this.resolveApproval("deny", message, activeSlot, index, reason);
  }

  private async resolveApproval(
    action: ApprovalDecision,
    message: BridgeInboundMessage,
    activeSlot: DaemonSlot | null,
    index: number | undefined,
    reason?: string,
  ): Promise<void> {
    const slot = await this.resolveApprovalTarget(message.senderId, activeSlot, index);
    if (!slot) {
      return;
    }

    const pending = slot.pendingConfirmations[0]!;
    const liveState = slot.runtime.getState();
    let requestId = pending.requestId;
    if (liveState.pendingApprovals !== undefined) {
      const shown = slot.displayedApprovalRequestId;
      if (!shown || !liveState.pendingApprovals.some((request) => request.requestId === shown)) {
        // The operator has not seen the current request yet (its prompt is
        // still queued, or the one they saw was settled locally): show it
        // instead of deciding blind.
        await this.host.queueMessage(
          message.senderId,
          this.host.slotManager.prefix(slot, formatApprovalMessage(pending, liveState)),
          "approval_required",
        );
        slot.displayedApprovalRequestId = pending.requestId;
        return;
      }
      requestId = shown;
    }
    const request = liveState.pendingApprovals?.find((candidate) => candidate.requestId === requestId) ?? pending;
    const reply = (text: string) => this.host.queueMessage(message.senderId, this.host.slotManager.prefix(slot, text));
    if ((action === "always" || action === "abort") && !request.extraDecisions?.includes(action)) {
      await reply(t(`approval.unsupported.${action}`, { adapter: slot.adapter }));
      return;
    }
    const nativeReason = action !== "confirm" && action !== "always" && reason && request.denyReasonSupported;
    const count = await slot.runtime.resolveApproval(action, requestId, nativeReason ? { reason } : undefined) ? 1 : 0;
    if (!count) {
      await reply(t(action === "confirm" || action === "always" ? "bridge.approval.applyFailed" : "bridge.approval.denyFailed"));
      return;
    }
    const adapterState = slot.runtime.getState();
    slot.pendingConfirmations = (adapterState.pendingApprovals ?? (adapterState.pendingApproval ? [adapterState.pendingApproval] : []))
      .map((request) => toPendingApproval({ type: "approval_required", request, timestamp: nowIso() }));
    this.host.daemonLog(
      `approval_resolved: adapter=${slot.adapter} decision=${action} reason=${reason ? (nativeReason ? "native" : "deferred") : "none"}`
        + ` command=${truncatePreview(request.commandPreview)}`,
    );
    if (!reason || action === "confirm" || action === "always") {
      await reply(t(`approval.resolved.${action}`));
      return;
    }
    if (nativeReason) {
      await reply(t("approval.resolved.denyWithReason"));
      return;
    }
    // The CLI cannot take a reason with the rejection: send it as the next
    // message once the turn settles (the deferred queue drains for Codex).
    if (slot.adapter === "codex") {
      slot.deferredInputs.push({ message: { ...message, text: t("approval.denyReasonPrompt", { reason }) } });
      await reply(t("approval.resolved.denyReasonQueued"));
      return;
    }
    await reply(t("approval.resolved.denyReasonDropped"));
  }

  /**
   * `/answer <reply>` answers the current slot's question;
   * `/answer #<number> <reply>` answers an entry of the waiting list;
   * a bare `/answer` lists every waiting question.
   */
  async answerPendingUserInput(
    message: BridgeInboundMessage,
    activeSlot: DaemonSlot | null,
    raw: string,
  ): Promise<void> {
    const waiting = this.slotsWhere((slot) => slot.pendingUserInput !== null);
    const listWaiting = () => waiting.map((slot, i) => t("daemon.answer.item", {
      index: i + 1,
      source: this.sourceOf(slot),
      summary: slot.pendingUserInput!.summary,
    })).join("\n");

    const numbered = raw.match(/^#(\d+)\s*([\s\S]*)$/);
    let slot: DaemonSlot;
    let reply = raw;
    if (numbered) {
      const index = Number(numbered[1]);
      const target = waiting[index - 1];
      reply = numbered[2] ?? "";
      if (!target) {
        await this.host.queueMessage(message.senderId, t("daemon.answer.badIndex", { index }));
        return;
      }
      slot = target;
    } else if (!raw.trim()) {
      await this.host.queueMessage(
        message.senderId,
        waiting.length > 0
          ? t("daemon.answer.list", { list: listWaiting() })
          : t("bridge.answer.none"),
      );
      return;
    } else if (activeSlot?.pendingUserInput) {
      slot = activeSlot;
    } else {
      await this.host.queueMessage(
        message.senderId,
        waiting.length > 0
          ? t("daemon.answer.pendingElsewhere", { list: listWaiting() })
          : t("bridge.answer.none"),
      );
      return;
    }

    const pending = slot.pendingUserInput!;
    const parsed = pending.questions.length > 1 && !isKeyedUserInputAnswer(reply, pending)
      ? this.answerNextQuestion(slot, pending, reply)
      : parsePendingUserInputAnswerCommand(reply, pending);
    if ("error" in parsed) {
      await this.host.queueMessage(
        message.senderId,
        this.host.slotManager.prefix(slot, parsed.error),
      );
      return;
    }
    if ("next" in parsed) {
      await this.host.queueMessage(
        message.senderId,
        this.host.slotManager.prefix(slot, formatUserInputQuestionMessage(pending, parsed.next, slot.runtime.getState())),
        "user_input_required",
      );
      return;
    }
    slot.userInputProgress = undefined;

    const submitted = await slot.runtime.submitUserInput(parsed.answers, pending.requestId);
    if (!submitted) {
      await this.host.queueMessage(
        message.senderId,
        this.host.slotManager.prefix(slot, t("bridge.answer.failed")),
      );
      return;
    }

    if (slot.pendingUserInput?.requestId === pending.requestId) slot.pendingUserInput = null;
    this.host.daemonLog(
      `user_input_answered: adapter=${slot.adapter} preview=${parsed.preview}`,
    );
    await this.host.queueMessage(
      message.senderId,
      this.host.slotManager.prefix(slot, t("bridge.answer.sent")),
    );
  }

  /**
   * Record the answer to the question the operator is on; returns the next
   * question's index, or every answer once the last one is answered.
   */
  private answerNextQuestion(
    slot: DaemonSlot,
    pending: PendingUserInputRequest,
    reply: string,
  ): { next: number } | { answers: Record<string, string[]>; preview: string } | { error: string } {
    const progress = slot.userInputProgress?.request === pending
      ? slot.userInputProgress
      : { request: pending, index: 0, answers: {} };
    const question = pending.questions[progress.index]!;
    const parsed = parseUserInputQuestionAnswer(question, reply);
    if ("error" in parsed) return parsed;
    progress.answers[question.id] = parsed.answers;
    progress.index++;
    slot.userInputProgress = progress;
    if (progress.index < pending.questions.length) return { next: progress.index };
    return { answers: progress.answers, preview: formatUserInputAnswerPreview(pending, progress.answers) };
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

  /**
   * `/all` broadcasts to every window of the current workspace: all CLI
   * types, or all numbered windows of one CLI. A single bridge has no use
   * for it.
   */
  private async handleBroadcastCommand(
    message: BridgeInboundMessage,
    text: string,
  ): Promise<void> {
    const slots = this.host.slotManager;
    if (!modeAllowsCommand(slots.mode, "all")) {
      await this.host.queueMessage(message.senderId, t("daemon.mode.allUnavailable"));
      return;
    }
    const cwd = slots.activeCwd;
    const startedSlots = slots.slotsIn(cwd);
    if (startedSlots.length === 0) {
      await this.host.queueMessage(
        message.senderId,
        t("daemon.broadcast.empty"),
      );
      return;
    }

    const busySlots = startedSlots.filter((slot) => this.isSlotBusyForBroadcast(slot));
    if (busySlots.length > 0) {
      const names = busySlots.map((slot) => slotName(slot)).join(", ");
      this.host.daemonLog(`broadcast_canceled_busy: busy=[${names}]`);
      await this.host.queueMessage(
        message.senderId,
        t("daemon.broadcast.busy", { workers: t(busySlots.length > 1 ? "daemon.broadcast.multipleBusy" : "daemon.broadcast.singleBusy"), names }),
      );
      return;
    }

    const broadcastMessage: BridgeInboundMessage = { ...message, text };
    const dispatched: string[] = [];
    for (const slot of startedSlots) {
      this.host.daemonLog(`broadcast_input: adapter=${slot.adapter} instance=${slot.instance} cwd=${cwd} text=${truncatePreview(text)}`);
      await this.host.dispatchInboundText(broadcastMessage, slot);
      dispatched.push(slotName(slot));
    }
    // Multi-CLI modes name the CLI types that did not get the prompt.
    const skipped = slots.mode.kind === "multi_instance"
      ? []
      : DAEMON_ADAPTERS.filter((adapter) => !startedSlots.some((slot) => slot.adapter === adapter));

    const lines = [
      t("daemon.broadcast.sent", { count: dispatched.length, workers: t(dispatched.length > 1 ? "daemon.broadcast.multipleWorkers" : "daemon.broadcast.singleWorker"), names: dispatched.join(", ") }),
    ];
    if (skipped.length > 0) {
      lines.push(t("daemon.broadcast.skipped", { names: skipped.join(", ") }));
    }
    await this.host.queueMessage(message.senderId, lines.join("\n"));
  }
}
