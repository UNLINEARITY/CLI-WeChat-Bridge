import { describe, expect, test } from "bun:test";

import { WecomChannelDriver } from "../../src/channels/wecom/wecom-driver.ts";
import type { WecomTransport } from "../../src/channels/wecom/wecom-transport.ts";

function makeDriver(transportOverrides: Partial<Record<"sendText", unknown>> = {}) {
  const logs: string[] = [];
  const sendTextCalls: Array<{ target: string; text: string; kind: string }> = [];
  const transport = {
    sendText: async (target: { recipientId: string }, text: string, kind: string) => {
      sendTextCalls.push({ target: target.recipientId, text, kind });
      if (typeof transportOverrides.sendText === "function") {
        return (transportOverrides.sendText as (i: number) => unknown)(sendTextCalls.length);
      }
    },
    setHandlers: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    waitUntilConnected: async () => undefined,
  } as unknown as WecomTransport;
  const driver = new WecomChannelDriver({
    transport,
    accountId: "bot-1",
    operatorId: "op-1",
    logError: () => undefined,
  });
  return { driver, logs, sendTextCalls };
}

describe("WecomChannelDriver basics", () => {
  test("identity, capabilities, and conversation refs", () => {
    const { driver } = makeDriver();
    expect(driver.id).toBe("wecom");
    expect(driver.displayName).toBe("WeCom");
    expect(driver.capabilities.multiConversation).toBe(true);
    expect(driver.capabilities.pushInbound).toBe(true);
    expect(driver.defaultConversation()).toEqual({
      channelId: "wecom",
      accountId: "bot-1",
      conversationId: "op-1",
      recipientId: "op-1",
      metadata: { chatType: "direct" },
    });
    expect(driver.directConversation("user-9").recipientId).toBe("user-9");
  });

  test("sendText formats visible text, maps kind, and logs sent", async () => {
    const { driver, logs, sendTextCalls } = makeDriver();
    const result = await driver.sendText({
      target: driver.directConversation("op-1"),
      text: "hello",
      context: "final_reply",
      log: (entry) => logs.push(entry),
    });

    expect(result.status).toBe("sent");
    expect(sendTextCalls.length).toBe(1);
    expect(sendTextCalls[0]!.kind).toBe("final_reply");
    expect(logs[0]).toContain("wecom_send_started");
    expect(logs[1]).toContain("wecom_send_completed");
  });

  test("sendText maps mirrored_user_input to mirrored_input and unknown kinds to notice", async () => {
    const { driver, sendTextCalls } = makeDriver();
    await driver.sendText({
      target: driver.directConversation("op-1"),
      text: "x",
      context: "mirrored_user_input",
      log: () => undefined,
    });
    await driver.sendText({
      target: driver.directConversation("op-1"),
      text: "y",
      context: "session_switched",
      log: () => undefined,
    });
    expect(sendTextCalls[0]!.kind).toBe("mirrored_input");
    expect(sendTextCalls[1]!.kind).toBe("notice");
  });

  test("sendText reports target_stale on transport failure", async () => {
    const { driver, logs } = makeDriver({ sendText: () => {
      throw new Error("connection closed");
    } });
    const result = await driver.sendText({
      target: driver.directConversation("op-1"),
      text: "hello",
      context: "message",
      log: (entry) => logs.push(entry),
    });

    expect(result.status).toBe("target_stale");
    if (result.status === "target_stale") {
      expect(result.target?.recipientId).toBe("op-1");
    }
    expect(logs.some((entry) => entry.includes("wecom_send_failed"))).toBe(true);
  });

  test("buildInboundPrompt includes attachment paths", () => {
    const { driver } = makeDriver();
    const prompt = driver.buildInboundPrompt("see this", [
      { kind: "file", path: "/tmp/a.bin", fileName: "a.bin", sizeBytes: 12 },
    ]);
    expect(prompt).toContain("see this");
    expect(prompt).toContain("path=/tmp/a.bin");
  });

  test("formatVisibleText is exposed", () => {
    const { driver } = makeDriver();
    expect(typeof driver.formatVisibleText).toBe("function");
  });
});
