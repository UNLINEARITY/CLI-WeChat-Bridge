// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { setLocale } from "../../src/i18n/index.ts";
import { beforeEach, describe, expect, test } from "bun:test";

import { WechatChannelDriver } from "../../src/channels/wechat/wechat-driver.ts";
import {
  WechatApiResponseError,
  type WeChatTransport,
} from "../../src/wechat/wechat-transport.ts";

beforeEach(() => setLocale("en"));

class FakeWechatTransport {
  sendAttempts = 0;
  clearedTokens: string[] = [];
  failWith: (attempt: number) => Error | null = () => null;
  typingTicket = "ticket-1";
  typingCalls: Array<{ recipientId: string; ticket: string; status: 1 | 2 }> = [];
  failTicket = false;

  async sendText(): Promise<void> {
    this.sendAttempts += 1;
    const error = this.failWith(this.sendAttempts);
    if (error) {
      throw error;
    }
  }

  async fetchTypingTicket(): Promise<string> {
    if (this.failTicket) {
      return "";
    }
    return this.typingTicket;
  }

  async sendTyping(
    recipientId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<boolean> {
    this.typingCalls.push({ recipientId, ticket: typingTicket, status });
    return true;
  }

  clearCachedContextToken(recipientId: string): boolean {
    this.clearedTokens.push(recipientId);
    return true;
  }
}

function makeDriver(transport: FakeWechatTransport) {
  const logs: string[] = [];
  const errors: string[] = [];
  const driver = new WechatChannelDriver({
    transport: transport as unknown as WeChatTransport,
    logError: (message) => errors.push(message),
    buildInboundPrompt: (text) => text,
  });
  return { driver, logs, errors };
}


describe("WechatChannelDriver basics", () => {
  test("identity, capabilities, and conversation refs", () => {
    const { driver } = makeDriver(new FakeWechatTransport());
    expect(driver.id).toBe("wechat");
    expect(driver.displayName).toBe("WeChat");
    expect(driver.capabilities.multiConversation).toBe(false);
    expect(driver.capabilities.pushInbound).toBe(false);
    expect(driver.defaultConversation()).toBeNull();
    expect(driver.directConversation("wx-1")).toEqual({
      channelId: "wechat",
      conversationId: "wx-1",
      recipientId: "wx-1",
    });
  });

  test("sendText succeeds on first attempt", async () => {
    const fake = new FakeWechatTransport();
    const { driver, logs } = makeDriver(fake);
    const result = await driver.sendText({
      target: driver.directConversation("wx-1"),
      text: "hi",
      context: "message",
      log: (entry) => logs.push(entry),
    });

    expect(result.status).toBe("sent");
    expect(fake.sendAttempts).toBe(1);
    expect(logs[0]).toContain("wechat_send_started");
    expect(logs[1]).toContain("wechat_send_completed");
  });

  test("stale context token clears the cache and reports target_stale", async () => {
    const fake = new FakeWechatTransport();
    fake.failWith = () => new WechatApiResponseError({ endpoint: "sendmessage", ret: -2 });
    const { driver, logs } = makeDriver(fake);
    const result = await driver.sendText({
      target: driver.directConversation("wx-1"),
      text: "hi",
      context: "message",
      log: (entry) => logs.push(entry),
    });

    expect(result.status).toBe("target_stale");
    if (result.status === "target_stale") {
      expect(result.target?.recipientId).toBe("wx-1");
    }
    expect(fake.clearedTokens).toEqual(["wx-1"]);
    expect(logs.some((entry) => entry.includes("wechat_send_"))).toBe(true);
  });

  test("retryable errors are retried up to the attempt limit", async () => {
    const fake = new FakeWechatTransport();
    let attempts = 0;
    fake.failWith = () => {
      attempts += 1;
      return attempts < 3
        ? new WechatApiResponseError({ endpoint: "sendmessage", ret: 1, errmsg: "temporary" })
        : null;
    };
    const { driver } = makeDriver(fake);
    const result = await driver.sendText({
      target: driver.directConversation("wx-1"),
      text: "hi",
      context: "message",
      log: () => undefined,
    });

    expect(result.status).toBe("sent");
    expect(fake.sendAttempts).toBe(3);
  });

  test("non-retryable error fails without extra attempts", async () => {
    const fake = new FakeWechatTransport();
    fake.failWith = () => new Error("unexpected protocol error");
    const { driver } = makeDriver(fake);
    const result = await driver.sendText({
      target: driver.directConversation("wx-1"),
      text: "hi",
      context: "message",
      log: () => undefined,
    });

    expect(result.status).toBe("failed");
    expect(fake.sendAttempts).toBe(1);
  });

  test("buildInboundPrompt delegates to the injected builder", () => {
    const { driver } = makeDriver(new FakeWechatTransport());
    expect(driver.buildInboundPrompt("plain", [])).toBe("plain");
  });

  test("beginTyping sends typing and keeps it alive until endTyping", async () => {
    const fake = new FakeWechatTransport();
    const logs: string[] = [];
    const driver = new WechatChannelDriver({
      transport: fake as unknown as WeChatTransport,
      logError: (message) => logs.push(message),
      buildInboundPrompt: (text) => text,
      typingKeepaliveMs: 10,
    });

    await driver.beginTyping("wx-1");
    expect(fake.typingCalls.length).toBe(1);
    expect(fake.typingCalls[0]).toEqual({ recipientId: "wx-1", ticket: "ticket-1", status: 1 });

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(fake.typingCalls.filter((call) => call.status === 1).length).toBeGreaterThan(2);

    await driver.endTyping("wx-1");
    const after = fake.typingCalls.length;
    expect(fake.typingCalls.at(-1)).toEqual({ recipientId: "wx-1", ticket: "ticket-1", status: 2 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.typingCalls.length).toBe(after);
    await driver.endAllTyping();
  });

  test("beginTyping stays silent when no ticket is available", async () => {
    const fake = new FakeWechatTransport();
    fake.failTicket = true;
    const driver = new WechatChannelDriver({
      transport: fake as unknown as WeChatTransport,
      logError: () => undefined,
      buildInboundPrompt: (text) => text,
    });

    await driver.beginTyping("wx-1");
    expect(fake.typingCalls).toHaveLength(0);
    await driver.endTyping("wx-1");
    expect(fake.typingCalls).toHaveLength(0);
  });

  test("an end that arrives during the ticket fetch leaves no indicator running", async () => {
    const fake = new FakeWechatTransport();
    let releaseTicket!: () => void;
    fake.fetchTypingTicket = () => new Promise<string>((resolve) => { releaseTicket = () => resolve("ticket-1"); });
    const driver = new WechatChannelDriver({
      transport: fake as unknown as WeChatTransport,
      logError: () => undefined,
      buildInboundPrompt: (text) => text,
      typingKeepaliveMs: 10,
    });

    const begin = driver.beginTyping("wx-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const end = driver.endTyping("wx-1");
    releaseTicket();
    await Promise.all([begin, end]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Nothing was sent: the begin step saw the end before sending typing.
    expect(fake.typingCalls.filter((call) => call.status === 1)).toEqual([]);
  });

  test("a cancel is sent only after an in-flight typing send completes", async () => {
    const fake = new FakeWechatTransport();
    const order: string[] = [];
    let releaseTyping!: () => void;
    fake.sendTyping = async (recipientId: string, ticket: string, status: 1 | 2) => {
      if (status === 1) await new Promise<void>((resolve) => { releaseTyping = resolve; });
      order.push(status === 1 ? "typing" : "cancel");
      fake.typingCalls.push({ recipientId, ticket, status });
      return true;
    };
    const driver = new WechatChannelDriver({
      transport: fake as unknown as WeChatTransport,
      logError: () => undefined,
      buildInboundPrompt: (text) => text,
      typingKeepaliveMs: 10,
    });

    const begin = driver.beginTyping("wx-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const end = driver.endTyping("wx-1");
    releaseTyping();
    await Promise.all([begin, end]);
    expect(order).toEqual(["typing", "cancel"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["typing", "cancel"]);
  });

  test("endAllTyping cancels every active indicator", async () => {
    const fake = new FakeWechatTransport();
    const driver = new WechatChannelDriver({
      transport: fake as unknown as WeChatTransport,
      logError: () => undefined,
      buildInboundPrompt: (text) => text,
      typingKeepaliveMs: 10,
    });

    await driver.beginTyping("wx-1");
    await driver.beginTyping("wx-2");
    await driver.endAllTyping();

    expect(fake.typingCalls.filter((call) => call.status === 2).length).toBe(2);
    const after = fake.typingCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.typingCalls.length).toBe(after);
  });
});
