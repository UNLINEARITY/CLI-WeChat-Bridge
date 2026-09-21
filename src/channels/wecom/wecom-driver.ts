import type {
  ChannelAttachment,
  ChannelConversationRef,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import type {
  ChannelDriver,
  ChannelDriverInboundHandlers,
  ChannelSendResult,
} from "../../core/channel-driver.ts";
import {
  buildWecomInboundPrompt,
  formatWecomVisibleText,
} from "./wecom-message.ts";
import { truncatePreview } from "../../core/text-utils.ts";
import type { WechatSendContext } from "../../core/channel-types.ts";
import type { WecomTransport } from "./wecom-transport.ts";

export function toWecomOutputKind(context: WechatSendContext): ChannelOutputKind {
  const known = new Set<ChannelOutputKind>([
    "status",
    "notice",
    "thinking",
    "final_reply",
    "approval_required",
    "user_input_required",
    "mirrored_input",
    "task_failed",
    "fatal_error",
  ]);
  return known.has(context as ChannelOutputKind)
    ? (context as ChannelOutputKind)
    : context === "mirrored_user_input"
      ? "mirrored_input"
      : "notice";
}

export type WecomChannelDriverOptions = {
  transport: WecomTransport;
  accountId?: string;
  operatorId: string;
  logError: (message: string) => void;
};

/** ChannelDriver over the official WeCom smart-bot WebSocket transport. */
export class WecomChannelDriver implements ChannelDriver {
  readonly id = "wecom";
  readonly displayName = "WeCom";
  readonly operatorDescription = "the paired WeCom operator";
  readonly capabilities = {
    streamingReplies: true,
    outboundAttachments: true,
    multiConversation: true,
    pushInbound: true,
  } as const;

  private readonly transport: WecomTransport;
  private readonly accountId?: string;
  private readonly operatorId: string;
  private readonly logError: (message: string) => void;

  constructor(options: WecomChannelDriverOptions) {
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
      channelId: "wecom",
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
    this.transport.start();
  }

  waitUntilReady(): Promise<void> {
    return this.transport.waitUntilConnected();
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
      `wecom_send_started: context=${context} recipient=${target.recipientId} chars=${Array.from(text).length}`,
    );
    try {
      await this.transport.sendText(
        target,
        formatWecomVisibleText(text),
        toWecomOutputKind(context),
      );
      log(
        `wecom_send_completed: context=${context} recipient=${target.recipientId} elapsed_ms=${Date.now() - startedAtMs}`,
      );
      return { status: "sent" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `wecom_send_failed: context=${context} recipient=${target.recipientId} error=${truncatePreview(message, 400)}`,
      );
      this.logError(`Failed to send WeCom ${context}: ${message}`);
      return {
        status: "target_stale",
        error,
        target,
      };
    }
  }

  buildInboundPrompt(text: string, attachments: ChannelAttachment[]): string {
    return buildWecomInboundPrompt(text, attachments);
  }

  formatVisibleText(text: string): string {
    return formatWecomVisibleText(text);
  }
}
