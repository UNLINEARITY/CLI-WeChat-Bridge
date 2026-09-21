// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { ChannelConversationRef } from "./channel-types.ts";
import {
  clearTurn,
  resolveConversationTarget,
  rollbackTurn,
  tryBeginTurn,
  type TurnLease,
  type TurnOwnershipState,
} from "./conversation-routing.ts";

export type TurnDispatchResult<TTask> =
  | { status: "dispatched"; task: TTask }
  | { status: "busy" };

export type TurnDispatchParams<TTask> = {
  task: TTask;
  conversation?: ChannelConversationRef;
  /**
   * Called when a turn is already active. When omitted, a busy input is
   * dropped without a reminder.
   */
  onBusy?: () => Promise<void> | void;
  forward: () => Promise<void>;
};

export type TurnCoordinatorOptions = {
  /**
   * Seed for the remembered conversation. Standalone WeCom bridges seed this
   * with the paired default conversation; daemon slots leave it unset.
   */
  initialLastConversation?: ChannelConversationRef | null;
  restoreLastConversationOnFailure?: boolean;
};

/**
 * Owns the active remote turn for one dispatch surface: a standalone bridge
 * or one daemon adapter slot. Wraps the turn ownership state machine (busy
 * rejection, dispatch rollback, conditional completion) so standalone and
 * daemon share identical gating semantics instead of re-implementing them.
 */
export class TurnCoordinator<TTask> {
  private readonly state: TurnOwnershipState<TTask>;
  private readonly restoreLastConversationOnFailure: boolean;

  constructor(options: TurnCoordinatorOptions = {}) {
    this.state = {
      activeTask: null,
      lastConversation: options.initialLastConversation ?? null,
    };
    this.restoreLastConversationOnFailure = options.restoreLastConversationOnFailure ?? false;
  }

  get activeTask(): TTask | null {
    return this.state.activeTask;
  }

  get hasActiveTask(): boolean {
    return this.state.activeTask !== null;
  }

  get activeConversation(): ChannelConversationRef | null | undefined {
    return this.state.activeConversation;
  }

  get lastConversation(): ChannelConversationRef | null | undefined {
    return this.state.lastConversation;
  }

  beginTurn(
    task: TTask,
    conversation?: ChannelConversationRef,
  ): TurnLease<TTask> | null {
    return tryBeginTurn(this.state, task, conversation);
  }

  rollback(
    lease: TurnLease<TTask>,
    options: { restoreLastConversation?: boolean } = {},
  ): boolean {
    return rollbackTurn(this.state, lease, options);
  }

  complete(expectedTask?: TTask): boolean {
    return clearTurn(this.state, expectedTask);
  }

  /**
   * Replaces the active task unconditionally. Used when a command path
   * (approval confirmation, resume) takes over a continuing turn rather
   * than dispatching fresh input.
   */
  setActiveTask(task: TTask): void {
    this.state.activeTask = task;
  }

  /** Binds a conversation as both active and remembered target. */
  bindConversation(conversation: ChannelConversationRef): void {
    this.state.activeConversation = conversation;
    this.state.lastConversation = conversation;
  }

  /** Records a conversation as the remembered fallback target only. */
  observeConversation(conversation: ChannelConversationRef): void {
    this.state.lastConversation = conversation;
  }

  resolveTarget(fallback: ChannelConversationRef): ChannelConversationRef {
    return resolveConversationTarget({
      active: this.state.activeConversation,
      last: this.state.lastConversation,
      fallback,
    });
  }

  /**
   * Busy-rejecting dispatch transaction: acquire the turn lease, forward the
   * input, and roll the lease back when forwarding throws. A busy input runs
   * `onBusy` (reminder) and returns without touching ownership.
   */
  async dispatch(params: TurnDispatchParams<TTask>): Promise<TurnDispatchResult<TTask>> {
    const lease = this.beginTurn(params.task, params.conversation);
    if (!lease) {
      await params.onBusy?.();
      return { status: "busy" };
    }
    try {
      await params.forward();
    } catch (error) {
      this.rollback(lease, {
        restoreLastConversation: this.restoreLastConversationOnFailure,
      });
      throw error;
    }
    return { status: "dispatched", task: params.task };
  }
}
