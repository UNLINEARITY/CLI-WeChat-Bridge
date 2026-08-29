import type { BridgeAdapterKind } from "../bridge/bridge-types.ts";

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
