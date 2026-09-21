// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import {
  resolveDaemonOutboundTarget,
  resolveOutboundConversationTarget,
} from "../../src/core/outbound-target.ts";

type Conv = { conversationId: string };

const conv = (id: string): Conv => ({ conversationId: id });
const direct = (senderId: string) => ({ channelId: "test", conversationId: senderId, recipientId: senderId });

describe("resolveOutboundConversationTarget (standalone priority)", () => {
  const base = {
    senderId: "op-1",
    operatorId: "op-1",
    multiConversation: true,
    operatorTarget: conv("operator-target"),
    directConversation: direct,
  };

  test("explicit override wins for everyone", () => {
    const override = conv("override");
    expect(
      resolveOutboundConversationTarget({ ...base, override }),
    ).toBe(override);
    expect(
      resolveOutboundConversationTarget({
        ...base,
        senderId: "stranger",
        override,
      }),
    ).toBe(override);
  });

  test("operator on multi-conversation channels gets the turn target", () => {
    expect(resolveOutboundConversationTarget(base)).toEqual(conv("operator-target"));
  });

  test("non-operator gets a direct conversation", () => {
    expect(
      resolveOutboundConversationTarget({ ...base, senderId: "user-2" }),
    ).toEqual(direct("user-2"));
  });

  test("single-conversation channels always route direct", () => {
    expect(
      resolveOutboundConversationTarget({ ...base, multiConversation: false }),
    ).toEqual(direct("op-1"));
  });
});

describe("resolveDaemonOutboundTarget (daemon priority)", () => {
  const base = {
    senderId: "op-1",
    operatorId: "op-1",
    multiConversation: true,
    fallbackConversation: conv("fallback"),
    directConversation: direct,
  };

  test("explicit override wins", () => {
    const override = conv("override");
    expect(resolveDaemonOutboundTarget({ ...base, override })).toBe(override);
  });

  test("operator prefers inbound conversation, then slot target, then fallback", () => {
    expect(
      resolveDaemonOutboundTarget({
        ...base,
        inboundConversation: conv("inbound"),
        activeSlotTarget: conv("slot"),
      }),
    ).toEqual(conv("inbound"));

    expect(
      resolveDaemonOutboundTarget({
        ...base,
        inboundConversation: null,
        activeSlotTarget: conv("slot"),
      }),
    ).toEqual(conv("slot"));

    expect(
      resolveDaemonOutboundTarget({
        ...base,
        inboundConversation: null,
        activeSlotTarget: null,
      }),
    ).toEqual(conv("fallback"));
  });

  test("non-operator and single-conversation channels route direct", () => {
    expect(
      resolveDaemonOutboundTarget({
        ...base,
        senderId: "user-3",
        inboundConversation: conv("inbound"),
      }),
    ).toEqual(direct("user-3"));
    expect(
      resolveDaemonOutboundTarget({
        ...base,
        multiConversation: false,
        inboundConversation: conv("inbound"),
      }),
    ).toEqual(direct("op-1"));
  });
});
