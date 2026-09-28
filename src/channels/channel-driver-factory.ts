// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeChannelId, ChannelAttachment } from "../core/channel-types.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type { WeChatTransport } from "../wechat/wechat-transport.ts";
import { WecomChannelDriver } from "./wecom/wecom-driver.ts";
import { WechatChannelDriver } from "./wechat/wechat-driver.ts";
import { LocalChannelDriver, type LocalChannelFiles } from "./local/local-driver.ts";
import type { WecomTransport } from "./wecom/wecom-transport.ts";

export type CreateChannelDriverInput = {
  channelId: BridgeChannelId;
  authorizedUserId: string;
  accountId?: string;
  wechatTransport: WeChatTransport | null;
  wecomTransport: WecomTransport | null;
  localFiles?: LocalChannelFiles | null;
  /**
   * Injected by the caller so the channel layer stays free of bridge-layer
   * imports (same boundary as the daemon's previous inline construction).
   */
  buildWechatInboundPrompt: (text: string, attachments: ChannelAttachment[]) => string;
  log: (message: string) => void;
  logError: (message: string) => void;
};

/**
 * Single construction point for channel drivers. Adding a channel means
 * adding a driver implementation and one branch here; orchestration layers
 * stay channel-neutral.
 */
export function createChannelDriver(input: CreateChannelDriverInput): ChannelDriver {
  if (input.channelId === "wecom") {
    if (!input.wecomTransport) {
      throw new Error("The wecom channel requires a WeCom transport.");
    }
    return new WecomChannelDriver({
      transport: input.wecomTransport,
      accountId: input.accountId,
      operatorId: input.authorizedUserId,
      logError: input.logError,
    });
  }
  if (input.channelId === "local") {
    const files: LocalChannelFiles = input.localFiles ?? {
      inboxFile: "",
      transcriptFile: "",
    };
    if (!files.inboxFile || !files.transcriptFile) {
      throw new Error("The local channel requires inbox and transcript file paths.");
    }
    return new LocalChannelDriver({
      operatorId: input.authorizedUserId,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
      log: input.log,
    });
  }
  if (!input.wechatTransport) {
    throw new Error("The wechat channel requires a WeChat transport.");
  }
  return new WechatChannelDriver({
    transport: input.wechatTransport,
    logError: input.logError,
    buildInboundPrompt: input.buildWechatInboundPrompt,
  });
}
