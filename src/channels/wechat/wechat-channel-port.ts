import type { BridgeAdapterKind } from "../../bridge/bridge-types.ts";
import { forwardWechatFinalReply } from "./bridge-final-reply.ts";
import type {
  BridgeChannelPort,
  ChannelAttachment,
  ChannelOutput,
  ChannelConversationRef,
} from "../../core/channel-types.ts";

export type WechatChannelPortDependencies = {
  sendText: (recipientId: string, text: string, context: string) => Promise<boolean | void>;
  sendImage: (recipientId: string, filePath: string) => Promise<unknown>;
  sendFile: (recipientId: string, filePath: string) => Promise<unknown>;
  sendVoice: (recipientId: string, filePath: string) => Promise<unknown>;
  sendVideo: (recipientId: string, filePath: string) => Promise<unknown>;
  prefixText?: (adapter: BridgeAdapterKind | undefined, text: string) => string;
  onEmptyVisibleReply?: (adapter: BridgeAdapterKind | undefined, rawText: string) => void;
  onTextSent?: (adapter: BridgeAdapterKind | undefined, text: string) => void;
};

function getRecipient(target: ChannelConversationRef): string {
  if (target.channelId !== "wechat") {
    throw new Error(`WeChat channel cannot send to ${target.channelId}.`);
  }
  return target.recipientId;
}

function attachmentSender(
  deps: WechatChannelPortDependencies,
  recipientId: string,
  attachment: ChannelAttachment,
): Promise<unknown> {
  switch (attachment.kind) {
    case "image":
      return deps.sendImage(recipientId, attachment.path);
    case "file":
      return deps.sendFile(recipientId, attachment.path);
    case "voice":
      return deps.sendVoice(recipientId, attachment.path);
    case "video":
      return deps.sendVideo(recipientId, attachment.path);
  }
}

/**
 * Channel boundary for WeChat output. The bridge core emits ChannelOutput;
 * this port owns WeChat prefixes, final-reply parsing, and media dispatch.
 */
export class WechatChannelPort implements BridgeChannelPort {
  readonly channelId = "wechat";
  private readonly deps: WechatChannelPortDependencies;

  constructor(deps: WechatChannelPortDependencies) {
    this.deps = deps;
  }

  async send(output: ChannelOutput): Promise<boolean> {
    const recipientId = getRecipient(output.target);
    const prefixText = (text: string) =>
      this.deps.prefixText?.(output.adapter, text) ?? text;
    const context =
      typeof output.metadata?.sendContext === "string"
        ? output.metadata.sendContext
        : output.kind;

    if (output.kind === "final_reply") {
      await forwardWechatFinalReply({
        adapter: output.adapter ?? "codex",
        rawText: output.text ?? "",
        onEmptyVisibleReply: ({ rawVisibleText }) => {
          this.deps.onEmptyVisibleReply?.(output.adapter, rawVisibleText);
        },
        sender: {
          sendText: async (text) => {
            const sent = await this.deps.sendText(
              recipientId,
              prefixText(text),
              "final_reply",
            );
            if (sent) {
              this.deps.onTextSent?.(output.adapter, text);
            }
            return sent;
          },
          sendImage: (filePath) => this.deps.sendImage(recipientId, filePath),
          sendFile: (filePath) => this.deps.sendFile(recipientId, filePath),
          sendVoice: (filePath) => this.deps.sendVoice(recipientId, filePath),
          sendVideo: (filePath) => this.deps.sendVideo(recipientId, filePath),
        },
      });
      return true;
    }

    if (output.attachment) {
      await attachmentSender(this.deps, recipientId, output.attachment);
    }

    if (output.text?.trim()) {
      return Boolean(
        await this.deps.sendText(recipientId, prefixText(output.text), context),
      );
    }

    return true;
  }
}
