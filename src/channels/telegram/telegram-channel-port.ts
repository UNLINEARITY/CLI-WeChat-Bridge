// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeAdapterKind } from "../../bridge/bridge-types.ts";
import type {
  BridgeChannelPort,
  ChannelAttachment,
  ChannelConversationRef,
  ChannelOutput,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import { forwardWecomFinalReply } from "../wecom/bridge-final-reply.ts";
import { formatTelegramVisibleText } from "./telegram-message.ts";
import type { TelegramTransport } from "./telegram-transport.ts";

export type TelegramChannelPortDependencies = {
  transport: Pick<TelegramTransport, "sendText" | "sendAttachment">;
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

export class TelegramChannelPort implements BridgeChannelPort {
  readonly channelId = "telegram";
  private readonly deps: TelegramChannelPortDependencies;

  constructor(deps: TelegramChannelPortDependencies) {
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
      throw new Error(`Telegram channel cannot send to ${output.target.channelId}.`);
    }
    const prefix = (text: string) =>
      formatTelegramVisibleText(
        this.deps.prefixText?.(output.adapter, text) ?? text,
      );

    if (output.kind === "final_reply") {
      // Final-reply splitting (attachment extraction etc.) is channel-neutral;
      // the WeCom implementation is reused verbatim.
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
