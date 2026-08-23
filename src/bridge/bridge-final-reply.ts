import type { BridgeAdapterKind } from "./bridge-types.ts";
import {
  formatFinalReplyMessage,
  parseWechatFinalReply,
  sanitizeWechatFinalReplyText,
  splitWechatTextIntoChunks,
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
    // Send long replies in bounded chunks: a single oversized sendmessage call
    // can be rejected by the WeChat API, silently losing the whole reply.
    const chunks = splitWechatTextIntoChunks(visibleText);
    for (let index = 0; index < chunks.length; index += 1) {
      const sent = await sender.sendText(chunks[index]!);
      if (sent === false) {
        // The send channel is failing (e.g. an expired context token).
        // Report what was dropped instead of ending mid-reply silently;
        // this notice itself is best effort and may also fail.
        const remainingChunks = chunks.length - index - 1;
        if (remainingChunks > 0 || parsed.attachments.length > 0) {
          const parts: string[] = [];
          if (remainingChunks > 0) {
            parts.push(`${remainingChunks} reply chunk(s)`);
          }
          if (parsed.attachments.length > 0) {
            parts.push(`${parsed.attachments.length} attachment(s)`);
          }
          await sender.sendText(
            `[bridge] Reply delivery was interrupted; ${parts.join(" and ")} could not be sent. Send a new message to retry.`,
          );
        }
        return;
      }
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
