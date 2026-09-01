import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PendingWechatMessageStore,
  getPendingWechatMessagesFile,
} from "../../src/bridge/wechat-outbound-queue.ts";

describe("pending WeChat outbound messages", () => {
  test("persists queued messages and removes them after delivery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-outbound-"));
    const filePath = path.join(directory, "pending.json");

    try {
      const store = new PendingWechatMessageStore(filePath);
      const queued = store.enqueue(" owner@im.wechat ", " reply text ", "final_reply");

      expect(queued).toMatchObject({
        recipientId: "owner@im.wechat",
        text: "reply text",
        context: "final_reply",
      });
      expect(new PendingWechatMessageStore(filePath).list()).toEqual([queued]);

      expect(store.remove(queued!.id)).toBe(true);
      expect(new PendingWechatMessageStore(filePath).list()).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses a workspace-scoped queue file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-workspace-"));
    try {
      expect(getPendingWechatMessagesFile(cwd)).toContain("pending-wechat-messages.json");
      expect(getPendingWechatMessagesFile(cwd)).toContain(path.basename(cwd));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("persists an opaque channel target for cross-conversation retry", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-outbound-"));
    const filePath = path.join(directory, "pending.json");
    try {
      const store = new PendingWechatMessageStore(filePath);
      store.enqueue("operator", "final", "final_reply", {
        channelId: "wecom",
        accountId: "bot-1",
        conversationId: "group-1",
        recipientId: "group-1",
        metadata: { chatType: "group" },
      });

      expect(new PendingWechatMessageStore(filePath).list()[0]?.target).toEqual({
        channelId: "wecom",
        accountId: "bot-1",
        conversationId: "group-1",
        recipientId: "group-1",
        metadata: { chatType: "group" },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
