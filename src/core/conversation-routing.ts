// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { AsyncLocalStorage } from "node:async_hooks";

import type { ChannelConversationRef } from "./channel-types.ts";

/**
 * Keeps the reply target scoped to one inbound async call chain. Different
 * conversations may run concurrently without overwriting each other's target.
 */
export class InboundConversationContext {
  private readonly storage = new AsyncLocalStorage<ChannelConversationRef>();

  run<T>(
    conversation: ChannelConversationRef,
    callback: () => T,
  ): T {
    return this.storage.run(conversation, callback);
  }

  get(): ChannelConversationRef | undefined {
    return this.storage.getStore();
  }
}

export type TurnOwnershipState<TTask> = {
  activeTask: TTask | null;
  activeConversation?: ChannelConversationRef | null;
  lastConversation?: ChannelConversationRef | null;
};

export type TurnLease<TTask> = {
  task: TTask;
  previousConversation?: ChannelConversationRef | null;
  previousLastConversation?: ChannelConversationRef | null;
};

export function tryBeginTurn<TTask>(
  state: TurnOwnershipState<TTask>,
  task: TTask,
  conversation?: ChannelConversationRef,
): TurnLease<TTask> | null {
  if (state.activeTask) {
    return null;
  }

  const lease: TurnLease<TTask> = {
    task,
    previousConversation: state.activeConversation,
    previousLastConversation: state.lastConversation,
  };
  state.activeTask = task;
  if (conversation) {
    state.activeConversation = conversation;
    state.lastConversation = conversation;
  }
  return lease;
}

export function rollbackTurn<TTask>(
  state: TurnOwnershipState<TTask>,
  lease: TurnLease<TTask>,
  options: { restoreLastConversation?: boolean } = {},
): boolean {
  if (state.activeTask !== lease.task) {
    return false;
  }

  state.activeTask = null;
  state.activeConversation = lease.previousConversation;
  if (options.restoreLastConversation) {
    state.lastConversation = lease.previousLastConversation;
  }
  return true;
}

export function clearTurn<TTask>(
  state: TurnOwnershipState<TTask>,
  expectedTask?: TTask,
): boolean {
  if (expectedTask && state.activeTask !== expectedTask) {
    return false;
  }

  state.activeTask = null;
  state.activeConversation = undefined;
  return true;
}

export function resolveConversationTarget(params: {
  active?: ChannelConversationRef | null;
  last?: ChannelConversationRef | null;
  fallback: ChannelConversationRef;
}): ChannelConversationRef {
  return params.active ?? params.last ?? params.fallback;
}
