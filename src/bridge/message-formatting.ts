// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import type {
  AutoApprovalKind,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeResumeThreadCandidate,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeState,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  PendingApproval,
} from "./bridge-types.ts";
import { truncatePreview } from "../core/text-utils.ts";

export function formatStatusReport(
  bridgeState: BridgeState,
  adapterState: BridgeAdapterState,
): string {
  const pending = bridgeState.pendingConfirmation;
  const pendingUserInput = bridgeState.pendingUserInput;
  const persistedSharedSessionId =
    bridgeState.sharedSessionId ?? bridgeState.sharedThreadId;
  const sharedSessionId =
    adapterState.sharedSessionId ?? adapterState.sharedThreadId;
  const lastSessionSwitchAt =
    adapterState.lastSessionSwitchAt ?? adapterState.lastThreadSwitchAt;
  const lastSessionSwitchSource =
    adapterState.lastSessionSwitchSource ?? adapterState.lastThreadSwitchSource;
  const lastSessionSwitchReason =
    adapterState.lastSessionSwitchReason ?? adapterState.lastThreadSwitchReason;
  const formatEpochMs = (value?: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toISOString()
      : t("status.none");

  return [
    `${t("status.label.instance_id")}: ${bridgeState.instanceId}`,
    `${t("status.label.adapter")}: ${bridgeState.adapter}`,
    `${t("status.label.command")}: ${bridgeState.command}`,
    `${t("status.label.cwd")}: ${bridgeState.cwd}`,
    `${t("status.label.profile")}: ${bridgeState.profile ?? t("status.none")}`,
    `${t("status.label.bridge_started_at")}: ${formatEpochMs(bridgeState.bridgeStartedAtMs)}`,
    `${t("status.label.authorized_user")}: ${bridgeState.authorizedUserId}`,
    `${t("status.label.ignored_backlog_count")}: ${bridgeState.ignoredBacklogCount}`,
    `${t("status.label.persisted_shared_session_id")}: ${persistedSharedSessionId ?? t("status.none")}`,
    `${t("status.label.worker_status")}: ${adapterState.status}`,
    `${t("status.label.worker_pid")}: ${adapterState.pid ?? t("status.unknown")}`,
    `${t("status.label.shared_session_id")}: ${sharedSessionId ?? t("status.none")}`,
    `${t("status.label.last_session_switch_at")}: ${lastSessionSwitchAt ?? t("status.none")}`,
    `${t("status.label.last_session_switch_source")}: ${lastSessionSwitchSource ?? t("status.none")}`,
    `${t("status.label.last_session_switch_reason")}: ${lastSessionSwitchReason ?? t("status.none")}`,
    `${t("status.label.active_turn_id")}: ${adapterState.activeTurnId ?? t("status.none")}`,
    `${t("status.label.active_turn_origin")}: ${adapterState.activeTurnOrigin ?? t("status.none")}`,
    `${t("status.label.pending_approval_origin")}: ${adapterState.pendingApprovalOrigin ?? t("status.none")}`,
    `${t("status.label.pending_user_input_origin")}: ${adapterState.pendingUserInputOrigin ?? t("status.none")}`,
    `${t("status.label.last_activity_at")}: ${bridgeState.lastActivityAt ?? t("status.none")}`,
    `${t("status.label.last_input_at")}: ${adapterState.lastInputAt ?? t("status.none")}`,
    `${t("status.label.last_output_at")}: ${adapterState.lastOutputAt ?? t("status.none")}`,
    `${t("status.label.pending_confirmation")}: ${pending ? `${pending.source}:${pending.code}` : t("status.none")}`,
    `${t("status.label.pending_user_input")}: ${pendingUserInput ? t("status.questions", { count: pendingUserInput.questions.length }) : t("status.none")}`,
  ].join("\n");
}

export function formatSessionSwitchMessage(params: {
  adapter: BridgeAdapterKind;
  sessionId: string;
  source: BridgeSessionSwitchSource;
  reason: BridgeSessionSwitchReason;
}): string {
  const shortSessionId = params.sessionId.slice(0, 12);

  const adapter = params.adapter === "claude" ? "Claude" : params.adapter === "opencode" ? "OpenCode" : params.adapter === "pi" ? "Pi" : "Codex";
  const noun = t(params.adapter === "codex" ? "session.thread" : "session.noun");
  const key = ["local_follow", "local_session_fallback", "local_turn"].includes(params.reason)
    ? "session.switch.local"
    : params.reason === "wechat_resume" ? "session.switch.remote"
    : params.reason === "startup_restore" ? "session.switch.restore" : "session.switch.generic";
  return t(key, { adapter, noun, id: shortSessionId });
}

export function formatThreadSwitchMessage(params: {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
}): string {
  return formatSessionSwitchMessage({
    adapter: "codex",
    sessionId: params.threadId,
    source: params.source,
    reason: params.reason,
  });
}

export function formatResumeSessionList(params: {
  adapter: BridgeAdapterKind;
  candidates: BridgeResumeSessionCandidate[];
  currentSessionId?: string;
}): string {
  const { adapter, candidates, currentSessionId } = params;
  const name = adapter === "codex" ? "Codex" : adapter === "opencode" ? "OpenCode" : adapter === "pi" ? "Pi" : "Claude";
  const noun = t(adapter === "codex" ? "session.threads" : "session.sessions");
  if (candidates.length === 0) return t("session.list.empty", { adapter: name, noun });
  const title = t("session.list.header", { adapter: name, noun });
  return [
    title,
    ...candidates.map((candidate, index) => {
      const marker =
        currentSessionId && candidate.sessionId === currentSessionId ? t("session.list.current") : "";
      return `${index + 1}. ${candidate.title} (${candidate.lastUpdatedAt}, ${candidate.sessionId.slice(0, 12)})${marker}`;
    }),
    t("session.list.instructions"),
  ].join("\n");
}

export function formatResumeThreadList(
  candidates: BridgeResumeThreadCandidate[],
  currentThreadId?: string,
): string {
  return formatResumeSessionList({
    adapter: "codex",
    candidates: candidates.map((candidate) => ({
      ...candidate,
      sessionId: candidate.sessionId ?? candidate.threadId ?? "",
      threadId: candidate.threadId ?? candidate.sessionId,
    })),
    currentSessionId: currentThreadId,
  });
}

export function formatMirroredUserInputMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label =
    adapter === "codex"
      ? t("session.localInput", { adapter: "Codex" })
      : adapter === "claude"
        ? t("session.localInput", { adapter: "Claude" })
        : adapter === "opencode"
          ? t("session.localInput", { adapter: "OpenCode" })
          : adapter === "pi"
            ? t("session.localInput", { adapter: "Pi" })
          : "Local input";
  return `${label}:\n${truncatePreview(text, 500)}`;
}

export function formatFinalReplyMessage(
  _adapter: BridgeAdapterKind,
  text: string,
): string {
  return text;
}

export function formatTaskFailedMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const label =
    adapter === "codex"
      ? "Codex"
      : adapter === "claude"
        ? "Claude"
        : adapter === "opencode"
          ? "OpenCode"
          : adapter === "pi"
            ? "Pi"
            : adapter;
  return t("session.taskFailed", { adapter: label, text });
}

const AUTO_APPROVAL_KINDS: AutoApprovalKind[] = ["command", "file_write", "permissions", "network", "read", "other"];

/** One line listing what was approved automatically, or null if nothing was. */
export function formatAutoApprovalSummary(counts: Partial<Record<AutoApprovalKind, number>>): string | null {
  const items = AUTO_APPROVAL_KINDS.flatMap((kind) => {
    const count = counts[kind] ?? 0;
    return count > 0 ? [t(`approval.auto.kind.${kind}`, { count })] : [];
  });
  return items.length ? t("approval.auto.summary", { items: items.join(t("approval.auto.separator")) }) : null;
}

/** "N more waiting" for the requests queued behind the one shown. */
function formatQueuedApprovals(adapterState: BridgeAdapterState): string[] {
  const queued = (adapterState.pendingApprovals?.length ?? 0) - 1;
  return queued > 0 ? [t("approval.queued", { count: queued })] : [];
}

export function formatApprovalMessage(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  const isClaude = adapterState.kind === "claude";
  if (isClaude) {
    const detailLabel = !pending.detailLabel || pending.detailLabel === "details"
      ? t("approval.details")
      : ["plan", "command", "path", "pattern", "url"].includes(pending.detailLabel)
        ? t(`approval.label.${pending.detailLabel}`)
        : pending.detailLabel;
    return [
      t("approval.claude.header"),
      ...(pending.toolName ? [`${t("approval.tool")}: ${pending.toolName}`] : []),
      ...(pending.detailPreview
        ? [`${detailLabel}: ${pending.detailPreview}`]
        : pending.commandPreview
          ? [`${t("approval.details")}: ${pending.commandPreview}`]
          : []),
      t("approval.confirmInstructions"),
      t("approval.denyInstructions"),
      ...formatQueuedApprovals(adapterState),
    ].join("\n");
  }

  return [
    t("approval.cli.header"),
    `${t("approval.adapter")}: ${adapterState.kind}`,
    `${t("approval.summary")}: ${pending.summary}`,
    `${t("approval.target")}: ${pending.commandPreview}`,
    t("approval.confirmInstructions"),
    t("approval.denyInstructions"),
    ...formatQueuedApprovals(adapterState),
  ].join("\n");
}

export function formatPendingApprovalReminder(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
): string {
  if (adapterState.kind === "claude") {
    const target = pending.toolName
      ? `${pending.toolName}${pending.detailPreview ? ` (${pending.detailPreview})` : ""}`
      : pending.commandPreview;
    return t("approval.pending.claude", { target: truncatePreview(target, 140) });
  }

  return t("approval.pending", { target: pending.commandPreview });
}
