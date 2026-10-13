// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";
import type { ChannelAttachment, ChannelConversationRef } from "../../src/core/channel-types.ts";
import { parseCliArgs, wireAdapterEvents } from "../../src/bridge/wechat-bridge.ts";

type WireParams = Parameters<typeof wireAdapterEvents>[0];

function bridge(channelId: "wechat" | "wecom" | "telegram") {
  let sink: (event: BridgeEvent) => void = () => {};
  let target: ChannelConversationRef = {
    channelId, conversationId: "original-chat", recipientId: "original-chat",
    metadata: { messageId: "original-message" },
  };
  const originalTarget = target;
  const texts: Array<{ text: string; context?: string; target?: ChannelConversationRef }> = [];
  const attachments: Array<{ target: ChannelConversationRef; attachment: ChannelAttachment }> = [];
  const wechatMedia: string[] = [];
  const errors: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const logs: string[] = [];
  const task = { startedAt: 1, inputPreview: "remote input" };
  let completed = false;
  const params = {
    adapter: {
      setEventSink: (next: (event: BridgeEvent) => void) => { sink = next; },
      getState: () => ({}),
    } as unknown as WireParams["adapter"],
    options: parseCliArgs(["--adapter", "codex", "--channel", channelId]),
    channelDriver: {
      id: channelId,
      capabilities: { multiConversation: channelId !== "wechat" },
      directConversation: (senderId: string) => ({ channelId, conversationId: senderId, recipientId: senderId }),
    } as unknown as WireParams["channelDriver"],
    stateStore: {
      getState: () => ({ authorizedUserId: "operator" }),
      appendLog: (text: string) => { logs.push(text); },
      clearPendingConfirmation() {}, clearPendingUserInput() {},
    } as unknown as WireParams["stateStore"],
    transport: {
      sendImage: async (filePath: string) => { wechatMedia.push(filePath); },
      sendFile: async (filePath: string) => { wechatMedia.push(filePath); },
      sendVoice: async (filePath: string) => { wechatMedia.push(filePath); },
      sendVideo: async (filePath: string) => { wechatMedia.push(filePath); },
    } as unknown as WireParams["transport"],
    wecomTransport: {
      sendAttachment: async (current: ChannelConversationRef, attachment: ChannelAttachment) => {
        attachments.push({ target: current, attachment });
      },
    } as unknown as NonNullable<WireParams["wecomTransport"]>,
    telegramTransport: {
      sendAttachment: async (current: ChannelConversationRef, attachment: ChannelAttachment) => {
        attachments.push({ target: current, attachment });
      },
    } as unknown as NonNullable<WireParams["telegramTransport"]>,
    resumeCoordinator: {} as WireParams["resumeCoordinator"],
    outputBatcher: { flushNow: async () => {} } as unknown as WireParams["outputBatcher"],
    queueWechatMessage: async (_id: string, text: string, context?: string, override?: ChannelConversationRef) => {
      texts.push({ text, context, target: override });
      return true;
    },
    queueWechatAttachmentAction: async <T>(action: () => Promise<T>) => await action(),
    trackWechatForwardTask: (promise: Promise<void>) => {
      tasks.push(promise.catch((error) => { errors.push(error); }));
    },
    getActiveTask: () => task,
    clearActiveTask: (expected: typeof task | null) => { completed = expected === task; },
    getWecomTarget: () => target,
    syncSharedSessionState() {}, syncLocalClientEndpoint() {}, requestShutdown() {},
    maybeDrainDeferredInboundMessages: async () => {},
  };
  wireAdapterEvents(params);
  return {
    texts, attachments, wechatMedia, errors, logs, originalTarget,
    completed: () => completed,
    setTarget: (next: ChannelConversationRef) => { target = next; },
    emit: (event: BridgeEvent) => sink(event),
    drain: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.all(tasks);
    },
  };
}

describe("standalone channel final replies", () => {
  for (const channelId of ["wechat", "wecom", "telegram"] as const) {
    test(`${channelId} forwards the Codex final reply and settles the turn`, async () => {
      const env = bridge(channelId);
      env.emit({ type: "final_reply", text: "The task is done.", timestamp: "now" });
      env.emit({ type: "task_complete", timestamp: "now" });
      await env.drain();
      expect(env.errors).toEqual([]);
      expect(env.texts).toHaveLength(1);
      expect(env.texts[0]?.text).toBe("The task is done.");
      expect(env.texts[0]?.context).toBe("final_reply");
      if (channelId !== "wechat") {
        expect(env.texts[0]?.target).toBe(env.originalTarget);
      }
      expect(env.completed()).toBe(true);
    });
  }

  test("Telegram final text and attachments retain the conversation captured before async forwarding", async () => {
    const env = bridge("telegram");
    env.emit({ type: "final_reply", timestamp: "now", text: [
      "Report ready.", "```wechat-attachments", "file /tmp/report.pdf", "```",
    ].join("\n") });
    env.setTarget({ channelId: "telegram", conversationId: "another-chat", recipientId: "another-chat" });
    await env.drain();
    expect(env.errors).toEqual([]);
    expect(env.texts[0]).toEqual({ text: "Report ready.", context: "final_reply", target: env.originalTarget });
    expect(env.attachments).toEqual([{ target: env.originalTarget, attachment: { kind: "file", path: "/tmp/report.pdf" } }]);
    expect(env.wechatMedia).toEqual([]);
  });
});
