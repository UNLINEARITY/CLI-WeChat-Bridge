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
  ChannelOutput,
} from "../../core/channel-types.ts";

export type LocalChannelPortDependencies = {
  sendText: (recipientId: string, text: string, context: string) => Promise<boolean | void>;
  sendAttachment?: (recipientId: string, attachment: ChannelAttachment) => Promise<unknown>;
  prefixText?: (adapter: BridgeAdapterKind | undefined, text: string) => string;
  onEmptyVisibleReply?: (adapter: BridgeAdapterKind | undefined, rawText: string) => void;
  onTextSent?: (adapter: BridgeAdapterKind | undefined, text: string) => void;
};

/**
 * Channel boundary for local loopback output. Unlike WeChat there is no
 * plain-text conversion: the harness consumes the raw final reply.
 */
export class LocalChannelPort implements BridgeChannelPort {
  readonly channelId = "local";
  private readonly deps: LocalChannelPortDependencies;

  constructor(deps: LocalChannelPortDependencies) {
    this.deps = deps;
  }

  async send(output: ChannelOutput): Promise<boolean> {
    if (output.target.channelId !== "local") {
      throw new Error(`Local channel cannot send to ${output.target.channelId}.`);
    }
    const recipientId = output.target.recipientId;
    const prefixText = (text: string) =>
      this.deps.prefixText?.(output.adapter, text) ?? text;
    const context =
      typeof output.metadata?.sendContext === "string"
        ? output.metadata.sendContext
        : output.kind;

    if (output.kind === "final_reply") {
      const rawText = output.text ?? "";
      if (!rawText.trim()) {
        this.deps.onEmptyVisibleReply?.(output.adapter, rawText);
        return true;
      }
      const sent = await this.deps.sendText(recipientId, prefixText(rawText), "final_reply");
      if (sent) {
        this.deps.onTextSent?.(output.adapter, rawText);
      }
      return true;
    }

    if (output.attachment) {
      await this.deps.sendAttachment?.(recipientId, output.attachment);
    }

    if (output.text?.trim()) {
      return Boolean(
        await this.deps.sendText(recipientId, prefixText(output.text), context),
      );
    }

    return true;
  }
}
