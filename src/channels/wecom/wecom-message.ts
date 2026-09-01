import type {
  BaseMessage,
  MixedMsgItem,
  QuoteContent,
  WsFrame,
} from "@wecom/aibot-node-sdk";

import type {
  ChannelAttachment,
  ChannelInboundMessage,
} from "../../core/channel-types.ts";

export type WecomInboundAttachmentDescriptor = {
  kind: "image" | "file" | "video";
  url: string;
  aesKey?: string;
  fileName?: string;
};

export type ParsedWecomInboundFrame = {
  id: string;
  reqId: string;
  senderId: string;
  conversationId: string;
  chatType: "direct" | "group";
  text: string;
  createdAt: string;
  attachments: WecomInboundAttachmentDescriptor[];
};

function appendMixedContent(
  items: MixedMsgItem[] | undefined,
  textParts: string[],
  attachments: WecomInboundAttachmentDescriptor[],
): void {
  for (const item of items ?? []) {
    if (item.msgtype === "text" && item.text?.content) {
      textParts.push(item.text.content);
    } else if (item.msgtype === "image" && item.image?.url) {
      attachments.push({
        kind: "image",
        url: item.image.url,
        aesKey: item.image.aeskey,
      });
    }
  }
}

function appendQuote(
  quote: QuoteContent | undefined,
  textParts: string[],
  attachments: WecomInboundAttachmentDescriptor[],
): void {
  if (!quote) {
    return;
  }
  const quotedText = quote.text?.content || quote.voice?.content;
  if (quotedText) {
    textParts.push(`[Quoted message]\n${quotedText}`);
  }
  if (quote.image?.url) {
    attachments.push({
      kind: "image",
      url: quote.image.url,
      aesKey: quote.image.aeskey,
    });
  }
  if (quote.file?.url) {
    attachments.push({
      kind: "file",
      url: quote.file.url,
      aesKey: quote.file.aeskey,
    });
  }
  const quotedVideo = (
    quote as QuoteContent & {
      video?: { url?: string; aeskey?: string };
    }
  ).video;
  if (quotedVideo?.url) {
    attachments.push({
      kind: "video",
      url: quotedVideo.url,
      aesKey: quotedVideo.aeskey,
    });
  }
  appendMixedContent(quote.mixed?.msg_item, textParts, attachments);
}

export function parseWecomInboundFrame(
  frame: WsFrame<BaseMessage>,
): ParsedWecomInboundFrame | null {
  const body = frame.body;
  if (!body?.msgid || !body.from?.userid || !frame.headers?.req_id) {
    return null;
  }

  const textParts: string[] = [];
  const attachments: WecomInboundAttachmentDescriptor[] = [];
  if (body.msgtype === "text" && body.text?.content) {
    textParts.push(body.text.content);
  } else if (body.msgtype === "voice" && body.voice?.content) {
    textParts.push(body.voice.content);
  } else if (body.msgtype === "mixed") {
    appendMixedContent(body.mixed?.msg_item, textParts, attachments);
  } else if (body.msgtype === "image" && body.image?.url) {
    attachments.push({
      kind: "image",
      url: body.image.url,
      aesKey: body.image.aeskey,
    });
  } else if (body.msgtype === "file" && body.file?.url) {
    attachments.push({
      kind: "file",
      url: body.file.url,
      aesKey: body.file.aeskey,
    });
  } else if (body.msgtype === "video" && body.video?.url) {
    attachments.push({
      kind: "video",
      url: body.video.url,
      aesKey: body.video.aeskey,
    });
  }
  appendQuote(body.quote, textParts, attachments);

  const isGroup = body.chattype === "group" && Boolean(body.chatid);
  const timestampMs =
    typeof body.create_time === "number" && body.create_time > 0
      ? body.create_time * 1000
      : Date.now();
  return {
    id: body.msgid,
    reqId: frame.headers.req_id,
    senderId: body.from.userid,
    conversationId: isGroup ? body.chatid! : body.from.userid,
    chatType: isGroup ? "group" : "direct",
    text: textParts.join("\n").trim(),
    createdAt: new Date(timestampMs).toISOString(),
    attachments,
  };
}

export function toWecomChannelInboundMessage(
  parsed: ParsedWecomInboundFrame,
  attachments: ChannelAttachment[],
  accountId: string,
): ChannelInboundMessage {
  return {
    id: parsed.id,
    conversation: {
      channelId: "wecom",
      accountId,
      conversationId: parsed.conversationId,
      recipientId: parsed.conversationId,
      opaqueRef: parsed.reqId,
      metadata: {
        chatType: parsed.chatType,
        messageId: parsed.id,
      },
    },
    senderId: parsed.senderId,
    text: parsed.text,
    attachments,
    createdAt: parsed.createdAt,
    metadata: {
      chatType: parsed.chatType,
      reqId: parsed.reqId,
    },
  };
}

export function buildWecomInboundPrompt(
  text: string,
  attachments: Array<{
    kind: string;
    path: string;
    fileName?: string;
    sizeBytes?: number;
  }> = [],
): string {
  const normalizedText = text.trim();
  if (attachments.length === 0) {
    return normalizedText;
  }
  const lines = [
    "[WeCom inbound attachments — ACTION REQUIRED]",
    "Use the local attachment paths below when the user asks you to inspect or process them.",
  ];
  attachments.forEach((attachment, index) => {
    const metadata = [
      `kind=${attachment.kind}`,
      attachment.fileName ? `name=${attachment.fileName}` : "",
      typeof attachment.sizeBytes === "number" ? `bytes=${attachment.sizeBytes}` : "",
    ].filter(Boolean);
    lines.push(`${index + 1}. ${metadata.join(" ")} path=${attachment.path}`);
  });
  return [normalizedText || "Received WeCom attachment(s).", lines.join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

export function formatWecomVisibleText(text: string): string {
  return text
    .replace(/\bWeChat\b/g, "WeCom")
    .replace(/\bwechat-(codex|claude|opencode|pi|daemon|setup)\b/g, "wecom-$1");
}
