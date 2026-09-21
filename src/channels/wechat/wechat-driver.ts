import type {
  ChannelAttachment,
  ChannelConversationRef,
} from "../../core/channel-types.ts";
import type {
  ChannelDriver,
  ChannelSendResult,
} from "../../core/channel-driver.ts";
import type { WechatSendContext } from "../../core/channel-types.ts";
import {
  WECHAT_SEND_MAX_ATTEMPTS,
  computeWechatSendRetryDelayMs,
  formatWechatContextTokenStaleLogEntry,
  formatWechatSendFailureLogEntry,
  formatWechatSendRetryLogEntry,
  isRetryableWechatSendError,
  isWechatContextUnavailableError,
} from "../../channels/wechat/wechat-forwarding.ts";
import {
  describeWechatTransportError,
  isWechatContextTokenStaleError,
  type WeChatTransport,
} from "../../wechat/wechat-transport.ts";
import { formatDuration } from "../../core/text-utils.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const WECHAT_CONTEXT_STALE_HINT =
  "WeChat conversation context is stale or unavailable. Ask the WeChat owner to send any message first, then local terminal replies can sync back to WeChat.";

export type WechatChannelDriverOptions = {
  transport: WeChatTransport;
  logError: (message: string) => void;
  /** Injected so the channel layer stays free of bridge-layer imports. */
  buildInboundPrompt: (text: string, attachments: ChannelAttachment[]) => string;
};

/** ChannelDriver over the WeChat iLink long-poll transport. */
export class WechatChannelDriver implements ChannelDriver {
  readonly id = "wechat";
  readonly displayName = "WeChat";
  readonly operatorDescription = "the configured WeChat owner";
  readonly capabilities = {
    streamingReplies: false,
    outboundAttachments: false,
    multiConversation: false,
    pushInbound: false,
  } as const;

  private readonly transport: WeChatTransport;
  private readonly logError: (message: string) => void;
  private readonly buildInboundPromptImpl: (text: string, attachments: ChannelAttachment[]) => string;

  constructor(options: WechatChannelDriverOptions) {
    this.transport = options.transport;
    this.logError = options.logError;
    this.buildInboundPromptImpl = options.buildInboundPrompt;
  }

  defaultConversation(): null {
    return null;
  }

  directConversation(senderId: string): ChannelConversationRef {
    return {
      channelId: "wechat",
      conversationId: senderId,
      recipientId: senderId,
    };
  }

  async sendText(params: {
    target: ChannelConversationRef;
    text: string;
    context: WechatSendContext;
    log: (entry: string) => void;
  }): Promise<ChannelSendResult> {
    const { target, text, context, log } = params;
    const senderId = target.recipientId;
    const startedAtMs = Date.now();
    log(
      `wechat_send_started: context=${context} recipient=${senderId} chars=${Array.from(text).length}`,
    );
    for (let attempt = 1; attempt <= WECHAT_SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.transport.sendText(senderId, text);
        log(
          `wechat_send_completed: context=${context} recipient=${senderId} attempt=${attempt} elapsed_ms=${Date.now() - startedAtMs}`,
        );
        return { status: "sent" };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          log(
            `wechat_send_timeout: context=${context} recipient=${senderId} attempt=${attempt} elapsed_ms=${Date.now() - startedAtMs}`,
          );
        }
        if (isWechatContextUnavailableError(err)) {
          if (isWechatContextTokenStaleError(err)) {
            this.transport.clearCachedContextToken(senderId);
          }
          this.logError(`Failed to send WeChat ${context}: ${WECHAT_CONTEXT_STALE_HINT}`);
          log(
            isWechatContextTokenStaleError(err)
              ? formatWechatContextTokenStaleLogEntry({
                  context,
                  recipientId: senderId,
                  error: err,
                })
              : formatWechatSendFailureLogEntry({
                  context,
                  recipientId: senderId,
                  error: err,
                }),
          );
          return {
            status: "target_stale",
            error: err,
            target,
          };
        }

        if (attempt < WECHAT_SEND_MAX_ATTEMPTS && isRetryableWechatSendError(err)) {
          const delayMs = computeWechatSendRetryDelayMs(attempt);
          this.logError(
            `Failed to send WeChat ${context} (attempt ${attempt}). Retrying in ${formatDuration(delayMs)}. ${describeWechatTransportError(err)}`,
          );
          log(
            formatWechatSendRetryLogEntry({
              context,
              recipientId: senderId,
              attempt,
              delayMs,
              error: err,
            }),
          );
          await delay(delayMs);
          continue;
        }

        this.logError(
          `Failed to send WeChat ${context}: ${describeWechatTransportError(err)}`,
        );
        log(
          formatWechatSendFailureLogEntry({
            context,
            recipientId: senderId,
            error: err,
          }),
        );
        return { status: "failed", error: err, target };
      }
    }
    return { status: "failed", error: new Error("unreachable"), target };
  }

  buildInboundPrompt(text: string, attachments: ChannelAttachment[]): string {
    return this.buildInboundPromptImpl(text, attachments);
  }
}
