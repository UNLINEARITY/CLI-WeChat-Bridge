import { describe, expect, test } from "bun:test";

import { WechatChannelDriver } from "../../src/channels/wechat/wechat-driver.ts";
import {
  WechatApiResponseError,
  type WeChatTransport,
} from "../../src/wechat/wechat-transport.ts";

class FakeWechatTransport {
  sendAttempts = 0;
  clearedTokens: string[] = [];
  failWith: (attempt: number) => Error | null = () => null;

  async sendText(): Promise<void> {
    this.sendAttempts += 1;
    const error = this.failWith(this.sendAttempts);
    if (error) {
      throw error;
    }
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
});
