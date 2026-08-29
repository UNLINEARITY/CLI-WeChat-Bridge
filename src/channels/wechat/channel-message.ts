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
