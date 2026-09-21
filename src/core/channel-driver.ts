// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type {
  ChannelAttachment,
  ChannelConversationRef,
  ChannelInboundMessage,
} from "./channel-types.ts";
import type { WechatSendContext } from "./channel-types.ts";

/**
 * Why a channel send could not complete, mapped to orchestration behavior:
 * - `sent`: delivered.
 * - `target_stale`: the remote conversation context is gone (e.g. a stale
 *   WeChat context_token). The orchestrator stashes the message in the
 *   pending store and flushes it after the next inbound message.
 * - `failed`: retries exhausted or unrecoverable; the orchestrator logs.
 */
export type ChannelSendResult =
  | { status: "sent" }
  | {
      status: "target_stale";
      error: unknown;
      target?: ChannelConversationRef;
    }
  | {
      status: "failed";
      error: unknown;
      target?: ChannelConversationRef;
    };

export type ChannelDriverInboundHandlers = {
  onInboundMessage(message: ChannelInboundMessage): Promise<void>;
  /** Push channels forward unauthorized direct senders for a stock reply. */
  onUnauthorizedSender?(senderId: string, chatType: string): Promise<void>;
  /** Push channels forward fatal transport errors. */
  onChannelFatal?(error: Error): Promise<void>;
  /** Push channels report connection recovery. */
  onChannelConnected?(): Promise<void>;
};

export type ChannelDriverCapabilities = {
  /** The channel delivers streaming/sequential reply chunks (WeCom). */
  readonly streamingReplies: boolean;
  /** The channel accepts outbound media uploads. */
  readonly outboundAttachments: boolean;
  /** Multiple conversations can be active concurrently (WeCom groups + DMs). */
  readonly multiConversation: boolean;
  /** The channel pushes inbound messages itself; the orchestrator waits instead of polling. */
  readonly pushInbound: boolean;
};

/**
 * Channel-neutral surface the bridge and daemon orchestration depends on.
 * Each messaging platform implements one driver; the orchestration layers
 * never branch on channel ids. Channel-level retries, stale-target
 * classification, and cache clearing happen inside the driver.
 */
export interface ChannelDriver {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ChannelDriverCapabilities;

  /** How the authorized operator is described in unauthorized-message notices. */
  readonly operatorDescription: string;

  /** Seed conversation for TurnCoordinator's remembered fallback. */
  defaultConversation(): ChannelConversationRef | null;

  /** Conversation ref for addressing an arbitrary sender directly. */
  directConversation(senderId: string): ChannelConversationRef;

  /**
   * Push-based channels (WeCom) start their transport here. Poll-based
   * channels (WeChat) leave this unimplemented; the orchestrator keeps
   * driving `pollOnce` itself.
   */
  start?(handlers: ChannelDriverInboundHandlers): Promise<void> | void;
  /** Resolves once a push channel is connected and delivering. */
  waitUntilReady?(): Promise<void>;

  /**
   * Send one text message. Channel-level retries and stale-state handling
   * are internal to the driver; the orchestrator only maps the result.
   */
  sendText(params: {
    target: ChannelConversationRef;
    text: string;
    context: WechatSendContext;
    log: (entry: string) => void;
  }): Promise<ChannelSendResult>;

  /** Prompt text handed to the CLI adapter for one inbound message. */
  buildInboundPrompt(text: string, attachments: ChannelAttachment[]): string;

  /** Show a "typing…" indicator for a recipient while a remote turn runs. */
  beginTyping?(recipientId: string): Promise<void>;
  /** Stop the indicator started by {@link beginTyping}. */
  endTyping?(recipientId: string): Promise<void>;
  /** Stop every active indicator; called during shutdown. */
  endAllTyping?(): Promise<void>;

  /** Visible formatting for outbound text; identity when not implemented. */
  formatVisibleText?(text: string): string;
}
