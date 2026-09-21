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

/** Per-recipient typing tickets with a random-refresh TTL and retry backoff. */
class TypingTicketCache {
  private readonly cache = new Map<string, {
    ticket: string;
    nextFetchAt: number;
    retryDelayMs: number;
  }>();

  constructor(
    private readonly fetchTicket: (recipientId: string) => Promise<string>,
    private readonly log: (message: string) => void,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly initialRetryMs = 2_000,
    private readonly maxRetryMs = 60 * 60 * 1000,
  ) {}

  async getFor(recipientId: string): Promise<string> {
    const now = Date.now();
    const entry = this.cache.get(recipientId);
    if (entry && now < entry.nextFetchAt) {
      return entry.ticket;
    }
    let ticket: string;
    try {
      ticket = await this.fetchTicket(recipientId);
    } catch {
      ticket = "";
    }
    if (ticket) {
      this.cache.set(recipientId, {
        ticket,
        nextFetchAt: now + Math.random() * this.ttlMs,
        retryDelayMs: this.initialRetryMs,
      });
      this.log(
        `wechat_typing_ticket_${entry ? "refreshed" : "cached"}: recipient=${recipientId}`,
      );
    } else {
      const retryDelayMs = Math.min(
        (entry?.retryDelayMs ?? this.initialRetryMs / 2) * 2,
        this.maxRetryMs,
      );
      this.cache.set(recipientId, {
        ticket: entry?.ticket ?? "",
        nextFetchAt: now + retryDelayMs,
        retryDelayMs,
      });
      this.log(`wechat_typing_ticket_fetch_failed: recipient=${recipientId} retry_in=${formatDuration(retryDelayMs)}`);
    }
    return this.cache.get(recipientId)?.ticket ?? "";
  }

  /** Cached ticket without triggering a fetch (for cancel sends). */
  peekCached(recipientId: string): string {
    return this.cache.get(recipientId)?.ticket ?? "";
  }
}

const WECHAT_CONTEXT_STALE_HINT =
  "WeChat conversation context is stale or unavailable. Ask the WeChat owner to send any message first, then local terminal replies can sync back to WeChat.";

export type WechatChannelDriverOptions = {
  transport: WeChatTransport;
  logError: (message: string) => void;
  /** Injected so the channel layer stays free of bridge-layer imports. */
  buildInboundPrompt: (text: string, attachments: ChannelAttachment[]) => string;
  /** Keepalive interval for the "typing…" indicator (tests use small values). */
  typingKeepaliveMs?: number;
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
  private readonly typingKeepaliveMs: number;
  private readonly typingTickets: TypingTicketCache;
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: WechatChannelDriverOptions) {
    this.transport = options.transport;
    this.logError = options.logError;
    this.buildInboundPromptImpl = options.buildInboundPrompt;
    this.typingKeepaliveMs = options.typingKeepaliveMs ?? 5_000;
    this.typingTickets = new TypingTicketCache(
      (recipientId) => this.transport.fetchTypingTicket(recipientId),
      (message) => this.logError(`[typing] ${message}`),
    );
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

  async beginTyping(recipientId: string): Promise<void> {
    if (this.typingTimers.has(recipientId)) {
      return;
    }
    const ticket = await this.typingTickets.getFor(recipientId);
    if (!ticket) {
      return;
    }
    const sent = await this.transport.sendTyping(recipientId, ticket, 1);
    if (!sent) {
      return;
    }
    const timer = setInterval(() => {
      void this.transport.sendTyping(recipientId, ticket, 1);
    }, this.typingKeepaliveMs);
    timer.unref?.();
    this.typingTimers.set(recipientId, timer);
  }

  async endTyping(recipientId: string): Promise<void> {
    const timer = this.typingTimers.get(recipientId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(recipientId);
    }
    const ticket = this.typingTickets.peekCached(recipientId);
    if (!ticket) {
      return;
    }
    await this.transport.sendTyping(recipientId, ticket, 2);
  }

  async endAllTyping(): Promise<void> {
    for (const recipientId of [...this.typingTimers.keys()]) {
      await this.endTyping(recipientId);
    }
  }
}
