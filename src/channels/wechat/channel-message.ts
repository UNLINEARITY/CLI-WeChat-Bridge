// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { InboundWechatMessage } from "../../wechat/wechat-transport.ts";
import type {
  ChannelAttachment,
  ChannelInboundMessage,
} from "../../core/channel-types.ts";

function toChannelAttachment(
  attachment: InboundWechatMessage["attachments"][number],
): ChannelAttachment {
  return {
    kind: attachment.kind,
    path: attachment.path,
    fileName: attachment.fileName,
    sizeBytes: attachment.sizeBytes,
  };
}

/** Convert the WeChat transport shape into the channel-neutral core shape. */
export function toChannelInboundMessage(
  message: InboundWechatMessage,
): ChannelInboundMessage {
  return {
    id: `${message.senderId}:${message.sessionId}:${message.createdAt}`,
    conversation: {
      channelId: "wechat",
      conversationId: message.sessionId || message.senderId,
      recipientId: message.senderId,
      opaqueRef: message.contextToken,
    },
    senderId: message.senderId,
    text: message.text,
    attachments: message.attachments.map(toChannelAttachment),
    createdAt: message.createdAt,
  };
}
