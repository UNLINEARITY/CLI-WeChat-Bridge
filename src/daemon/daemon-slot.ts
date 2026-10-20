// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeModeKind, WindowRefusal } from "./bridge-mode.ts";
import type { SlotSessionRecord } from "./slot-session-store.ts";
import path from "node:path";
import { BridgeController } from "../bridge/bridge-controller.ts";
import type {
  AutoApprovalKind,
  BridgeAdapter,
  BridgeEvent,
  BridgeSessionStartMode,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "../bridge/bridge-types.ts";
import { nowIso, OutputBatcher } from "../bridge/bridge-utils.ts";
import { ResumeSessionCoordinator } from "../bridge/bridge-session-resume.ts";
import type { BridgeInboundMessage } from "../core/channel-types.ts";
import { TurnCoordinator } from "../core/turn-coordinator.ts";
import type { ChannelConversationRef } from "../core/channel-types.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";

export type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

export type DaemonSlot = {
  adapter: DaemonAdapterKind;
  /** Workspace directory this slot's CLI runs in. */
  cwd: string;
  /** 1-based instance number of this adapter within its workspace. */
  instance: number;
  /** First thread seen for this slot; its opening is not announced. */
  knownThreadId?: string;
  /** The slot ends when its visible window closes (launcher or ephemeral daemon). */
  boundToWindow: boolean;
  /** Attached to a live Codex shared-daemon thread; the owning TUI keeps it. */
  attached: boolean;
  /** When the slot was created (ms). */
  createdAtMs: number;
  /** When the operator last switched to this slot (ms); 0 if never. */
  activatedAtMs: number;
  /** A window has been seen connected for this slot. */
  windowSeen?: boolean;
  /** Consecutive window checks that found no connected window. */
  windowMissingChecks?: number;
  /** Last session record written for this slot. */
  savedSession?: SlotSessionRecord;
  runtime: BridgeAdapter;
  controller: BridgeController;
  outputBatcher: OutputBatcher;
  pendingConfirmations: PendingApproval[];
  displayedApprovalRequestId?: string;
  /** Requests approved automatically since the last final reply. */
  autoApprovals: Partial<Record<AutoApprovalKind, number>>;
  pendingUserInput: PendingUserInputRequest | null;
  /** Answers collected so far while a multi-question request is answered one by one. */
  userInputProgress?: { request: PendingUserInputRequest; index: number; answers: Record<string, string[]> };
  resumeCoordinator: ResumeSessionCoordinator;
  turns: TurnCoordinator<ActiveTask>;
  lastOutputAt: number;
  lastFinalReplyAtMs: number;
  eventForwardChain: Promise<void>;
  deferredInputs: DeferredDaemonInput[];
  drainingDeferredInputs: boolean;
};

export type DeferredDaemonInput = {
  message: BridgeInboundMessage;
  conversation?: ChannelConversationRef;
};

export function toPendingApproval(request: BridgeEvent & { type: "approval_required" }): PendingApproval {
  const rawRequest = request.request;
  if (typeof (rawRequest as PendingApproval).createdAt === "string") {
    return rawRequest as PendingApproval;
  }

  return {
    ...rawRequest,
    createdAt: nowIso(),
  };
}

/** The question the operator is on within a multi-question request. */
export function currentUserInputIndex(slot: DaemonSlot): number {
  return slot.userInputProgress && slot.userInputProgress.request === slot.pendingUserInput
    ? slot.userInputProgress.index
    : 0;
}

export function toPendingUserInput(request: UserInputRequest | PendingUserInputRequest): PendingUserInputRequest {
  if (typeof (request as PendingUserInputRequest).createdAt === "string") {
    return request as PendingUserInputRequest;
  }

  return {
    ...request,
    createdAt: nowIso(),
  };
}

/** Prefix a message with its source, e.g. `[claude]` or `[my-app/claude]`. */
export function prefixSourceMessage(source: string, text: string): string {
  const trimmed = text.trim();
  return trimmed ? `[${source}]\n${trimmed}` : `[${source}]`;
}

export function formatInboundMessagePreview(message: BridgeInboundMessage): string {
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

export type EnsureSlotOptions = {
  profile?: string;
  cliArgs?: string[];
  openVisible?: boolean;
  sessionStartMode?: BridgeSessionStartMode;
  reuseExistingVisible?: boolean;
  /** Workspace for the slot; defaults to the current workspace. */
  cwd?: string;
  /** Make the slot the current one once it is ready; defaults to true. */
  activate?: boolean;
  /** End the slot when its visible window closes. */
  boundToWindow?: boolean;
  /** Codex only: attach to a live shared-daemon thread instead of a window. */
  codexAttach?: { threadId?: string };
  /**
   * Numbered window of the adapter in the workspace. Defaults to the one the
   * operator is on there, else the most recently used.
   */
  instance?: number;
  /** Ask for another window of the adapter even when the workspace has one. */
  newInstance?: boolean;
};

export type EnsureSlotResult = {
  activeAdapter: DaemonAdapterKind;
  cwd: string;
  /** Instance number of the slot the call prepared. */
  instance: number;
  created: boolean;
  openedVisible: boolean;
  visibleConnected: boolean;
  visibleReady: boolean;
  activated: boolean;
  activationVersion: number;
  previousActiveAdapter?: DaemonAdapterKind;
  previousActiveInstance?: number;
  previousActiveCwd: string;
  /** Refused by the bridge mode: the new window would mix directions. */
  refused?: WindowRefusal;
  /** Admitting the slot moved the bridge up to this mode. */
  upgradedTo?: BridgeModeKind;
  /** Thread the slot follows after the call (reported to attach launchers). */
  sharedThreadId?: string;
};

/** Display name of a slot: `codex`, or `codex-2` for a second instance. */
export function slotName(slot: Pick<DaemonSlot, "adapter" | "instance">): string {
  return slot.instance > 1 ? `${slot.adapter}-${slot.instance}` : slot.adapter;
}

/** Normalized identity of a workspace directory. */
export function workspaceKeyOf(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isSameWorkspace(left: string, right: string): boolean {
  return workspaceKeyOf(left) === workspaceKeyOf(right);
}

/**
 * Short, unambiguous display names for workspace directories: the directory
 * name, widened with parent segments until no two workspaces collide.
 */
export function workspaceLabels(cwds: string[]): Map<string, string> {
  const segmentsOf = (cwd: string) => path.resolve(cwd).split(/[\\/]+/).filter(Boolean);
  const labels = new Map<string, string>();
  const depth = new Map<string, number>(cwds.map((cwd) => [cwd, 1]));
  for (let round = 0; round < 8; round += 1) {
    const counts = new Map<string, number>();
    for (const cwd of cwds) {
      const label = segmentsOf(cwd).slice(-depth.get(cwd)!).join("/") || cwd;
      labels.set(cwd, label);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const colliding = cwds.filter((cwd) => (counts.get(labels.get(cwd)!) ?? 0) > 1);
    if (colliding.length === 0) {
      break;
    }
    for (const cwd of colliding) {
      depth.set(cwd, depth.get(cwd)! + 1);
    }
  }
  return labels;
}
