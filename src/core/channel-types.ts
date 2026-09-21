import type { BridgeAdapterKind } from "../bridge/bridge-types.ts";

export type BridgeChannelId = "wechat" | "wecom";

export function normalizeBridgeChannelId(value: unknown): BridgeChannelId {
  return value === "wecom" ? "wecom" : "wechat";
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

/**
 * Why an outbound message is being sent. The name is historical; the values
 * are channel-neutral and live here so the core stays free of channel-layer
 * imports. `channels/wechat/wechat-forwarding.ts` re-exports it for existing
 * callers until the Phase 4 rename.
 */
export type WechatSendContext =
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
