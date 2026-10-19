// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { PendingMessageStore } from "./pending-message-store.ts";
import type { ChannelDriver, ChannelSendResult } from "./channel-driver.ts";
import type { ChannelConversationRef, ChannelSendKind } from "./channel-types.ts";
import { truncatePreview } from "./text-utils.ts";

export type OutboundDispatcherOptions = {
  driver: ChannelDriver;
  pending: PendingMessageStore;
  /** Resolve the final send target; receives the target captured at queue time. */
  resolveSendTarget: (senderId: string, override?: ChannelConversationRef) => ChannelConversationRef;
  /** Capture the target when a message is queued, before earlier sends finish. */
  resolveQueuedTarget: (
    senderId: string,
    override?: ChannelConversationRef,
  ) => ChannelConversationRef | undefined;
  describeError: (error: unknown) => string;
  log: (entry: string) => void;
  logError: (message: string) => void;
};

/**
 * Serialized outbound delivery for one channel: text and attachments each go
 * through their own ordered chain, sends to a stale target are parked in the
 * pending store, and fire-and-forget forwarding tasks are tracked so shutdown
 * can wait for them.
 */
export class OutboundDispatcher {
  private readonly options: OutboundDispatcherOptions;
  private textSendChain = Promise.resolve();
  private attachmentSendChain = Promise.resolve();
  private readonly forwardTasks = new Set<Promise<void>>();

  constructor(options: OutboundDispatcherOptions) {
    this.options = options;
  }

  hasPending(): boolean {
    return this.options.pending.list().length > 0;
  }

  queueText<T>(action: () => Promise<T>): Promise<T> {
    const run = this.textSendChain.then(action);
    this.textSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  queueAttachment<T>(action: () => Promise<T>): Promise<T> {
    const run = this.attachmentSendChain.then(action);
    this.attachmentSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  sendNow(
    senderId: string,
    text: string,
    context: ChannelSendKind = "message",
    targetOverride?: ChannelConversationRef,
  ): Promise<ChannelSendResult> {
    return this.options.driver.sendText({
      target: this.options.resolveSendTarget(senderId, targetOverride),
      text,
      context,
      log: this.options.log,
    });
  }

  queueMessage(
    senderId: string,
    text: string,
    context: ChannelSendKind = "message",
    targetOverride?: ChannelConversationRef,
  ): Promise<boolean> {
    const queuedTarget = this.options.resolveQueuedTarget(senderId, targetOverride);
    return this.queueText(async () => {
      const result = await this.sendNow(senderId, text, context, queuedTarget);
      if (result.status === "target_stale") {
        const pending = this.options.pending.enqueue(
          senderId,
          text,
          context,
          result.target,
        );
        if (pending) {
          this.options.log(
            `wechat_send_queued: id=${pending.id} context=${context} recipient=${senderId} pending=${this.options.pending.list().length}`,
          );
        }
      }
      return result.status === "sent";
    });
  }

  flushPending(): Promise<void> {
    return this.queueText(async () => {
      for (const pending of this.options.pending.list()) {
        const result = await this.sendNow(
          pending.recipientId,
          pending.text,
          pending.context,
          pending.target,
        );
        if (result.status === "sent") {
          this.options.pending.remove(pending.id);
          this.options.log(
            `wechat_pending_sent: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
          );
          continue;
        }
        if (result.status === "target_stale") {
          break;
        }
        this.options.log(
          `wechat_pending_retryable_failure: id=${pending.id} context=${pending.context} recipient=${pending.recipientId}`,
        );
        break;
      }
    });
  }

  trackForwardTask(task: Promise<void>): void {
    const tracked = task
      .catch((error) => {
        const description = this.options.describeError(error);
        this.options.logError(`WeChat forward task failed: ${description}`);
        this.options.log(
          `wechat_forward_failed: error=${truncatePreview(description, 400)}`,
        );
      })
      .finally(() => {
        this.forwardTasks.delete(tracked);
      });
    this.forwardTasks.add(tracked);
  }

  async waitForForwardTasks(): Promise<void> {
    while (this.forwardTasks.size > 0) {
      await Promise.allSettled([...this.forwardTasks]);
    }
  }

  /** Wait for queued text and attachment sends to settle. */
  async drainSendChains(): Promise<void> {
    await this.textSendChain.catch(() => undefined);
    await this.attachmentSendChain.catch(() => undefined);
  }
}
