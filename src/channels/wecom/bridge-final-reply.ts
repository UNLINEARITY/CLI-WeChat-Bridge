// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";

import type { BridgeAdapterKind } from "../../bridge/bridge-types.ts";
import {
  formatFinalReplyMessage,
  parseWechatFinalReply,
  sanitizeWechatFinalReplyText,
} from "../../bridge/bridge-utils.ts";
import type {
  ChannelAttachment,
  ChannelConversationRef,
} from "../../core/channel-types.ts";

export type WecomFinalReplySender = {
  sendText: (text: string) => Promise<boolean>;
  sendAttachment: (attachment: ChannelAttachment) => Promise<void>;
};

export async function forwardWecomFinalReply(params: {
  adapter: BridgeAdapterKind;
  rawText: string;
  target: ChannelConversationRef;
  sender: WecomFinalReplySender;
  onEmptyVisibleReply?: (rawText: string) => void;
}): Promise<void> {
  const parsed = parseWechatFinalReply(params.rawText);
  const sanitized = sanitizeWechatFinalReplyText(params.adapter, parsed.visibleText);
  const visibleText = formatFinalReplyMessage(params.adapter, sanitized).trim();
  if (visibleText) {
    await params.sender.sendText(visibleText);
  } else if (params.adapter === "opencode" && parsed.visibleText.trim()) {
    params.onEmptyVisibleReply?.(parsed.visibleText);
    await params.sender.sendText(
      "OpenCode did not produce a visible reply. Check the local terminal output or retry the message.",
    );
  }

  for (const attachment of parsed.attachments) {
    try {
      await params.sender.sendAttachment({
        kind: attachment.kind,
        path: attachment.path,
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      await params.sender.sendText(
        `Failed to send ${attachment.kind} attachment ${path.basename(attachment.path)}: ${errorText}`,
      );
    }
  }
}
