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

describe("pending WeChat outbound queue hygiene", () => {
  function tempStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-outbound-"));
    const filePath = path.join(directory, "pending.json");
    return { directory, store: new PendingWechatMessageStore(filePath), filePath };
  }

  test("drops low-value contexts instead of queuing them", () => {
    const { directory, store } = tempStore();
    try {
      expect(store.enqueue("u1", "mirror", "mirrored_user_input")).toBeNull();
      expect(store.enqueue("u1", "notice", "notice")).toBeNull();
      expect(store.enqueue("u1", "switched", "thread_switched")).toBeNull();
      expect(store.enqueue("u1", "reply", "final_reply")).not.toBeNull();
      expect(store.list()).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("caps the backlog at ten entries, dropping the oldest first", () => {
    const { directory, store } = tempStore();
    try {
      for (let i = 1; i <= 12; i += 1) {
        store.enqueue("u1", `reply ${i}`, "final_reply");
      }
      const list = store.list();
      expect(list).toHaveLength(10);
      expect(list[0]!.text).toBe("reply 3");
      expect(list.at(-1)!.text).toBe("reply 12");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("expires entries older than the TTL on list and enqueue", () => {
    const { directory, store, filePath } = tempStore();
    try {
      store.enqueue("u1", "old reply", "final_reply");
      // Age the persisted entry past the 30-minute TTL.
      const aged = JSON.parse(fs.readFileSync(filePath, "utf8"));
      aged.messages[0].queuedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(aged));

      expect(new PendingWechatMessageStore(filePath).list()).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
