// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { BridgeController } from "../bridge/bridge-controller.ts";
import type {
  BridgeAdapter,
  BridgeEvent,
  BridgeSessionStartMode,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "../bridge/bridge-types.ts";
import { buildOneTimeCode, nowIso, OutputBatcher } from "../bridge/bridge-utils.ts";
import { ResumeSessionCoordinator } from "../bridge/bridge-session-resume.ts";
import type { InboundWechatMessage } from "../wechat/wechat-transport.ts";
import { TurnCoordinator } from "../core/turn-coordinator.ts";
import type { ChannelConversationRef } from "../core/channel-types.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";

export type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

export type DaemonSlot = {
  adapter: DaemonAdapterKind;
  runtime: BridgeAdapter;
  controller: BridgeController;
  outputBatcher: OutputBatcher;
  pendingConfirmations: PendingApproval[];
  displayedApprovalRequestId?: string;
  pendingUserInput: PendingUserInputRequest | null;
  resumeCoordinator: ResumeSessionCoordinator;
  turns: TurnCoordinator<ActiveTask>;
  lastOutputAt: number;
  lastFinalReplyAtMs: number;
  eventForwardChain: Promise<void>;
  deferredInputs: DeferredDaemonInput[];
  drainingDeferredInputs: boolean;
};

export type DeferredDaemonInput = {
  message: InboundWechatMessage;
  conversation?: ChannelConversationRef;
};

export function toPendingApproval(request: BridgeEvent & { type: "approval_required" }): PendingApproval {
  const rawRequest = request.request;
  if (typeof (rawRequest as PendingApproval).code === "string") {
    return rawRequest as PendingApproval;
  }

  return {
    ...rawRequest,
    code: buildOneTimeCode(),
    createdAt: nowIso(),
  };
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

export function prefixDaemonAdapterMessage(adapter: DaemonAdapterKind, text: string): string {
  const trimmed = text.trim();
  return trimmed ? `[${adapter}]\n${trimmed}` : `[${adapter}]`;
}

export function formatInboundMessagePreview(message: InboundWechatMessage): string {
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
};

export type EnsureSlotResult = {
  activeAdapter: DaemonAdapterKind;
  created: boolean;
  openedVisible: boolean;
  visibleConnected: boolean;
  visibleReady: boolean;
  activated: boolean;
  activationVersion: number;
  previousActiveAdapter?: DaemonAdapterKind;
};
