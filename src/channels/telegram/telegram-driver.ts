// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../../i18n/index.ts";
import type {
  ChannelConversationRef,
} from "../../core/channel-types.ts";
import type {
  ChannelDriver,
  ChannelDriverInboundHandlers,
  ChannelSendResult,
} from "../../core/channel-driver.ts";
import {
  buildTelegramInboundPrompt,
  formatTelegramVisibleText,
  toTelegramOutputKind,
} from "./telegram-message.ts";
import { truncatePreview } from "../../core/text-utils.ts";
import type { WechatSendContext } from "../../core/channel-types.ts";
import type { TelegramTransport } from "./telegram-transport.ts";

export type TelegramChannelDriverOptions = {
  transport: TelegramTransport;
  accountId?: string;
  operatorId: string;
  logError: (message: string) => void;
};

/** ChannelDriver over the official Telegram Bot API long-poll transport. */
export class TelegramChannelDriver implements ChannelDriver {
  readonly id = "telegram";
  readonly displayName = "Telegram";
  get operatorDescription(): string { return t("operator.telegram"); }
  readonly capabilities = {
    streamingReplies: false,
    outboundAttachments: true,
    multiConversation: true,
    pushInbound: true,
  } as const;

  private readonly transport: TelegramTransport;
  private readonly accountId?: string;
  private readonly operatorId: string;
  private readonly logError: (message: string) => void;

  constructor(options: TelegramChannelDriverOptions) {
    this.transport = options.transport;
    this.accountId = options.accountId;
    this.operatorId = options.operatorId;
    this.logError = options.logError;
  }

  defaultConversation(): ChannelConversationRef {
    return this.directConversation(this.operatorId);
  }

  directConversation(senderId: string): ChannelConversationRef {
    return {
      channelId: "telegram",
      accountId: this.accountId,
      conversationId: senderId,
      recipientId: senderId,
      metadata: { chatType: "direct" },
    };
  }

  start(handlers: ChannelDriverInboundHandlers): void {
    this.transport.setHandlers({
      onMessage: async (message) => {
        await handlers.onInboundMessage(message);
      },
      onUnauthorized: handlers.onUnauthorizedSender
        ? async (senderId, chatType) => {
            await handlers.onUnauthorizedSender!(senderId, chatType);
          }
        : undefined,
      onFatal: handlers.onChannelFatal
        ? async (error: Error) => {
            await handlers.onChannelFatal!(error);
          }
        : undefined,
      onConnected: handlers.onChannelConnected
        ? async () => {
            await handlers.onChannelConnected!();
          }
        : undefined,
    });
    void this.transport.start();
  }

  async waitUntilReady(): Promise<void> {
    // The long-poll loop reports readiness through onConnected; there is no
    // separate handshake to await, so readiness is immediate once started.
    await Promise.resolve();
  }

  async sendText(params: {
    target: ChannelConversationRef;
    text: string;
    context: WechatSendContext;
    log: (entry: string) => void;
  }): Promise<ChannelSendResult> {
    const { target, text, context, log } = params;
    const startedAtMs = Date.now();
    log(
      `telegram_send_started: context=${context} recipient=${target.recipientId} chars=${Array.from(text).length}`,
    );
    try {
      await this.transport.sendText(
        target,
        formatTelegramVisibleText(text),
        toTelegramOutputKind(context),
      );
      log(
        `telegram_send_completed: context=${context} recipient=${target.recipientId} elapsed_ms=${Date.now() - startedAtMs}`,
      );
      return { status: "sent" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `telegram_send_failed: context=${context} recipient=${target.recipientId} error=${truncatePreview(message, 400)}`,
      );
      this.logError(`Failed to send Telegram ${context}: ${message}`);
      return {
        status: "failed",
        error,
        target,
      };
    }
  }

  buildInboundPrompt(text: string, attachments: Parameters<typeof buildTelegramInboundPrompt>[1]): string {
    return buildTelegramInboundPrompt(text, attachments);
  }

  formatVisibleText(text: string): string {
    return formatTelegramVisibleText(text);
  }

  async beginTyping(recipientId: string): Promise<void> {
    await this.transport.beginTyping(recipientId);
  }

  async endTyping(recipientId: string): Promise<void> {
    await this.transport.endTyping(recipientId);
  }

  async endAllTyping(): Promise<void> {
    this.transport.endAllTyping();
  }
}
