// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeAdapterKind } from "../bridge/bridge-types.ts";

export const BRIDGE_CHANNEL_DISPLAY_NAMES = {
  wechat: "WeChat",
  wecom: "WeCom",
  telegram: "Telegram",
  local: "Local",
} as const;

export type BridgeChannelId = keyof typeof BRIDGE_CHANNEL_DISPLAY_NAMES;

export function isBridgeChannelId(value: unknown): value is BridgeChannelId {
  return typeof value === "string" && Object.hasOwn(BRIDGE_CHANNEL_DISPLAY_NAMES, value);
}

export function getBridgeChannelDisplayName(channelId: BridgeChannelId): string {
  return BRIDGE_CHANNEL_DISPLAY_NAMES[channelId];
}

export function normalizeBridgeChannelId(value: unknown): BridgeChannelId {
  return isBridgeChannelId(value) ? value : "wechat";
}

export type ChannelAttachmentKind = "image" | "file" | "voice" | "video";

/**
 * A channel-specific conversation handle. The core only carries opaqueRef;
 * it never interprets platform-specific tokens such as WeChat context_token.
 */
export type ChannelConversationRef = {
  channelId: string;
  accountId?: string;
  conversationId: string;
  recipientId: string;
  opaqueRef?: string;
  metadata?: Record<string, string>;
};

export type ChannelAttachment = {
  kind: ChannelAttachmentKind;
  path: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, string>;
};

export type ChannelInboundMessage = {
  id: string;
  conversation: ChannelConversationRef;
  senderId: string;
  text: string;
  attachments: ChannelAttachment[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

/** Why an outbound message is being sent; channel drivers map it to their own kinds. */
export type ChannelSendKind =
  | "final_reply"
  | "message"
  | "notice"
  | "approval_required"
  | "user_input_required"
  | "mirrored_user_input"
  | "session_switched"
  | "thread_switched"
  | "task_failed"
  | "fatal_error"
  | "inbound_error"
  | "thinking";

export type ChannelOutputKind =
  | "status"
  | "notice"
  | "thinking"
  | "final_reply"
  | "approval_required"
  | "user_input_required"
  | "mirrored_input"
  | "task_failed"
  | "fatal_error";

export type ChannelOutput = {
  target: ChannelConversationRef;
  kind: ChannelOutputKind;
  text?: string;
  attachment?: ChannelAttachment;
  adapter?: BridgeAdapterKind;
  metadata?: Record<string, unknown>;
};

/** The only output capability the channel-neutral core needs. */
export interface BridgeChannelPort {
  readonly channelId: string;
  send(output: ChannelOutput): Promise<boolean>;
}

export type BridgeInboundAttachmentKind = "image" | "file";

export type BridgeInboundAttachment = {
  kind: BridgeInboundAttachmentKind;
  path: string;
  fileName: string;
  sizeBytes: number;
};

/** One inbound text message as the daemon routes it, whatever the channel. */
export type BridgeInboundMessage = {
  senderId: string;
  sender: string;
  sessionId: string;
  text: string;
  attachments: BridgeInboundAttachment[];
  contextToken?: string;
  createdAt: string;
  createdAtMs?: number;
};
