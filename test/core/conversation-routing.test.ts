// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import {
  clearTurn,
  InboundConversationContext,
  resolveConversationTarget,
  rollbackTurn,
  tryBeginTurn,
  type TurnOwnershipState,
} from "../../src/core/conversation-routing.ts";
import type { ChannelConversationRef } from "../../src/core/channel-types.ts";

function conversation(id: string): ChannelConversationRef {
  return {
    channelId: "wecom",
    conversationId: id,
    recipientId: id,
    metadata: { chatType: id.startsWith("group-") ? "group" : "direct" },
  };
}

describe("conversation routing", () => {
  test("keeps concurrent inbound conversations isolated across awaits", async () => {
    const context = new InboundConversationContext();
    const direct = conversation("direct-a");
    const group = conversation("group-b");
    let releaseDirect!: () => void;
    let releaseGroup!: () => void;
    const directGate = new Promise<void>((resolve) => {
      releaseDirect = resolve;
    });
    const groupGate = new Promise<void>((resolve) => {
      releaseGroup = resolve;
    });

    const directRun = context.run(direct, async () => {
      expect(context.get()).toBe(direct);
      await directGate;
      return context.get();
    });
    const groupRun = context.run(group, async () => {
      expect(context.get()).toBe(group);
      await groupGate;
      return context.get();
    });

    releaseGroup();
    expect(await groupRun).toBe(group);
    releaseDirect();
    expect(await directRun).toBe(direct);
    expect(context.get()).toBeUndefined();
  });

  test("prefers the event slot's active target over global fallbacks", () => {
    const active = conversation("group-active");
    const last = conversation("direct-last");
    const fallback = conversation("direct-fallback");

    expect(resolveConversationTarget({ active, last, fallback })).toBe(active);
    expect(resolveConversationTarget({ last, fallback })).toBe(last);
    expect(resolveConversationTarget({ fallback })).toBe(fallback);
  });

  test("captures an event target before the slot is reused", () => {
    const first = conversation("direct-first");
    const second = conversation("group-second");
    const fallback = conversation("direct-fallback");
    const slot: {
      active?: ChannelConversationRef;
      last?: ChannelConversationRef;
    } = { active: first, last: first };

    const captured = resolveConversationTarget({ ...slot, fallback });
    slot.active = second;
    slot.last = second;

    expect(captured).toBe(first);
    expect(resolveConversationTarget({ ...slot, fallback })).toBe(second);
  });

  test("claims one active turn atomically and rejects a competing dispatch", () => {
    const state: TurnOwnershipState<{ id: string }> = {
      activeTask: null,
    };
    const firstTask = { id: "first" };
    const secondTask = { id: "second" };
    const firstTarget = conversation("direct-first");

    const lease = tryBeginTurn(state, firstTask, firstTarget);

    expect(lease).not.toBeNull();
    expect(tryBeginTurn(state, secondTask, conversation("group-second"))).toBeNull();
    expect(state.activeTask).toBe(firstTask);
    expect(state.activeConversation).toBe(firstTarget);
  });

  test("rolls back only the turn that owns the lease", () => {
    const previousTarget = conversation("direct-previous");
    const failedTarget = conversation("group-failed");
    const failedTask = { id: "failed" };
    const state: TurnOwnershipState<{ id: string }> = {
      activeTask: null,
      activeConversation: previousTarget,
      lastConversation: previousTarget,
    };
    const lease = tryBeginTurn(state, failedTask, failedTarget)!;

    expect(rollbackTurn(state, { ...lease, task: { id: "foreign" } })).toBe(false);
    expect(state.activeTask).toBe(failedTask);
    expect(rollbackTurn(state, lease)).toBe(true);
    expect(state.activeTask).toBeNull();
    expect(state.activeConversation).toBe(previousTarget);
    expect(state.lastConversation).toBe(failedTarget);
  });

  test("does not let a late completion clear a newer turn", () => {
    const oldTask = { id: "old" };
    const currentTask = { id: "current" };
    const state: TurnOwnershipState<{ id: string }> = {
      activeTask: currentTask,
      activeConversation: conversation("group-current"),
    };

    expect(clearTurn(state, oldTask)).toBe(false);
    expect(state.activeTask).toBe(currentTask);
    expect(clearTurn(state, currentTask)).toBe(true);
    expect(state.activeTask).toBeNull();
    expect(state.activeConversation).toBeUndefined();
  });
});
