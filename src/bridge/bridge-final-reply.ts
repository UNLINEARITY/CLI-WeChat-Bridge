import type { BridgeAdapterKind } from "./bridge-types.ts";
import {
  formatFinalReplyMessage,
  parseWechatFinalReply,
  sanitizeWechatFinalReplyText,
} from "./bridge-utils.ts";

export type WechatFinalReplySender = {
  sendText: (text: string) => Promise<boolean | void>;
  sendImage: (imagePath: string) => Promise<unknown>;
  sendFile: (filePath: string) => Promise<unknown>;
  sendVoice: (voicePath: string) => Promise<unknown>;
  sendVideo: (videoPath: string) => Promise<unknown>;
};

export const OPENCODE_EMPTY_VISIBLE_REPLY_MESSAGE =
  "OpenCode 没有产生可发送到微信的可见回复。请查看本地终端输出，或重试这条消息。";

export async function forwardWechatFinalReply(params: {
  adapter: BridgeAdapterKind;
  rawText: string;
  sender: WechatFinalReplySender;
  onEmptyVisibleReply?: (details: {
    adapter: BridgeAdapterKind;
    rawVisibleText: string;
  }) => void;
}): Promise<void> {
  const { adapter, rawText, sender, onEmptyVisibleReply } = params;
  const parsed = parseWechatFinalReply(rawText);
  const sanitizedText = sanitizeWechatFinalReplyText(adapter, parsed.visibleText);
  const visibleText = formatFinalReplyMessage(adapter, sanitizedText).trim();

  if (visibleText) {
    const sent = await sender.sendText(visibleText);
    if (sent === false) {
      return;
    }
  } else if (adapter === "opencode" && parsed.visibleText.trim()) {
    onEmptyVisibleReply?.({
      adapter,
      rawVisibleText: parsed.visibleText,
    });
    const sent = await sender.sendText(OPENCODE_EMPTY_VISIBLE_REPLY_MESSAGE);
    if (sent === false) {
      return;
    }
  }

  for (const attachment of parsed.attachments) {
    try {
      switch (attachment.kind) {
        case "image":
          await sender.sendImage(attachment.path);
          break;
        case "file":
          await sender.sendFile(attachment.path);
          break;
        case "voice":
          await sender.sendVoice(attachment.path);
          break;
        case "video":
          await sender.sendVideo(attachment.path);
          break;
      }
    } catch (error) {
      const errorText =
        error instanceof Error ? error.message : String(error ?? "unknown error");
      await sender.sendText(
        `Failed to send ${attachment.kind} attachment: ${attachment.path}\n${errorText}`,
      );
    }
  }
}
