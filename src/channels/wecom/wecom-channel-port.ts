import type { BridgeAdapterKind } from "../../bridge/bridge-types.ts";
import type {
  BridgeChannelPort,
  ChannelAttachment,
  ChannelConversationRef,
  ChannelOutput,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import { forwardWecomFinalReply } from "./bridge-final-reply.ts";
import { formatWecomVisibleText } from "./wecom-message.ts";
import type { WecomTransport } from "./wecom-transport.ts";

export type WecomChannelPortDependencies = {
  transport: Pick<WecomTransport, "sendText" | "sendAttachment">;
  sendText?: (
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ) => Promise<boolean>;
  sendAttachment?: (
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ) => Promise<void>;
  prefixText?: (adapter: BridgeAdapterKind | undefined, text: string) => string;
  onEmptyVisibleReply?: (adapter: BridgeAdapterKind | undefined, rawText: string) => void;
};

export class WecomChannelPort implements BridgeChannelPort {
  readonly channelId = "wecom";
  private readonly deps: WecomChannelPortDependencies;

  constructor(deps: WecomChannelPortDependencies) {
    this.deps = deps;
  }

  private sendText(
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ): Promise<boolean> {
    return this.deps.sendText?.(target, text, kind) ??
      this.deps.transport.sendText(target, text, kind);
  }

  private sendAttachment(
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ): Promise<void> {
    return this.deps.sendAttachment?.(target, attachment) ??
      this.deps.transport.sendAttachment(target, attachment);
  }

  async send(output: ChannelOutput): Promise<boolean> {
    if (output.target.channelId !== this.channelId) {
      throw new Error(`WeCom channel cannot send to ${output.target.channelId}.`);
    }
    const prefix = (text: string) =>
      formatWecomVisibleText(
        this.deps.prefixText?.(output.adapter, text) ?? text,
      );

    if (output.kind === "final_reply") {
      await forwardWecomFinalReply({
        adapter: output.adapter ?? "codex",
        rawText: output.text ?? "",
        target: output.target,
        onEmptyVisibleReply: (rawText) => {
          this.deps.onEmptyVisibleReply?.(output.adapter, rawText);
        },
        sender: {
          sendText: (text) =>
            this.sendText(output.target, prefix(text), "final_reply"),
          sendAttachment: (attachment) =>
            this.sendAttachment(output.target, attachment),
        },
      });
      return true;
    }

    if (output.attachment) {
      await this.sendAttachment(output.target, output.attachment);
    }
    if (output.text?.trim()) {
      return this.sendText(
        output.target,
        prefix(output.text),
        output.kind,
      );
    }
    return true;
  }
}
