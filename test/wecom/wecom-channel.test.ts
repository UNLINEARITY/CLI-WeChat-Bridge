import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  BaseMessage,
  SendMsgBody,
  UploadMediaFinishResult,
  UploadMediaOptions,
  WeComMediaType,
  WsFrame,
  WsFrameHeaders,
} from "@wecom/aibot-node-sdk";

import { tryClaimChannelInboundMessage } from "../../src/core/inbound-message-claims.ts";
import {
  loadStoredWecomAccount,
  resolveWecomAccount,
  saveWecomAccount,
  type StoredWecomAccount,
} from "../../src/channels/wecom/wecom-config.ts";
import {
  formatWecomVisibleText,
  parseWecomInboundFrame,
  toWecomChannelInboundMessage,
} from "../../src/channels/wecom/wecom-message.ts";
import { downloadWecomAttachment } from "../../src/channels/wecom/wecom-media.ts";
import {
  createWecomPairingCode,
  isWecomPairingMessage,
  pairWecomOperator,
} from "../../src/channels/wecom/setup.ts";
import {
  WecomTransport,
  type WecomSdkClient,
} from "../../src/channels/wecom/wecom-transport.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-channel-test-"));
  tempDirs.push(directory);
  return directory;
}

const account: StoredWecomAccount = {
  version: 1,
  botId: "bot-1",
  secret: "secret-1",
  operatorUserId: "user-1",
  pairedAt: "2026-08-31T00:00:00.000Z",
};

function textFrame(overrides: Partial<BaseMessage> = {}): WsFrame<BaseMessage> {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-1" },
    body: {
      msgid: "msg-1",
      aibotid: "bot-1",
      chattype: "single",
      from: { userid: "user-1" },
      msgtype: "text",
      text: { content: "hello" },
      create_time: 1_700_000_000,
      ...overrides,
    },
  };
}

class FakeWecomClient extends EventEmitter implements WecomSdkClient {
  isConnected = false;
  replyStreamCalls: Array<{ reqId: string; streamId: string; text: string; finish: boolean }> = [];
  activeMessages: Array<{ chatId: string; body: SendMsgBody }> = [];
  uploads: Array<{ options: UploadMediaOptions; size: number }> = [];
  mediaMessages: Array<{ chatId: string; type: WeComMediaType; mediaId: string }> = [];
  failNextReply = false;

  connect(): this {
    this.isConnected = true;
    return this;
  }

  disconnect(): void {
    this.isConnected = false;
  }

  async replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish = false,
  ): Promise<WsFrame> {
    if (this.failNextReply) {
      this.failNextReply = false;
      throw new Error("expired stream");
    }
    this.replyStreamCalls.push({
      reqId: frame.headers.req_id,
      streamId,
      text: content,
      finish,
    });
    return { headers: { req_id: frame.headers.req_id }, errcode: 0 };
  }

  async replyStreamNonBlocking(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish = false,
  ): Promise<WsFrame | "skipped"> {
    return this.replyStream(frame, streamId, content, finish);
  }

  async sendMessage(chatId: string, body: SendMsgBody): Promise<WsFrame> {
    this.activeMessages.push({ chatId, body });
    return { headers: { req_id: `active-${this.activeMessages.length}` }, errcode: 0 };
  }

  async uploadMedia(
    buffer: Buffer,
    options: UploadMediaOptions,
  ): Promise<UploadMediaFinishResult> {
    this.uploads.push({ options, size: buffer.length });
    return { type: options.type, media_id: "media-1", created_at: "now" };
  }

  async sendMediaMessage(
    chatId: string,
    type: WeComMediaType,
    mediaId: string,
  ): Promise<WsFrame> {
    this.mediaMessages.push({ chatId, type, mediaId });
    return { headers: { req_id: "media-send" }, errcode: 0 };
  }
}

describe("wecom configuration and pairing", () => {
  test("stores credentials atomically and allows environment overrides", () => {
    const filePath = path.join(makeTempDir(), "account.json");
    saveWecomAccount(account, filePath);
    expect(loadStoredWecomAccount(filePath)).toEqual(account);
    expect(resolveWecomAccount({ WECOM_BOT_SECRET: "override" }, account)?.secret).toBe(
      "override",
    );
  });

  test("accepts an exact direct-chat pairing command only", () => {
    const code = createWecomPairingCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(
      isWecomPairingMessage(
        textFrame({ text: { content: `/pair ${code}` } }),
        code,
      ),
    ).toBe(true);
    expect(
      isWecomPairingMessage(
        textFrame({ chattype: "group", chatid: "group-1", text: { content: `/pair ${code}` } }),
        code,
      ),
    ).toBe(false);
  });

  test("pairs the first matching direct-chat operator", async () => {
    const client = new FakeWecomClient();
    const pairing = pairWecomOperator({
      botId: "bot-1",
      secret: "secret-1",
      code: "123456",
      timeoutMs: 1_000,
      clientFactory: () => client,
      log: () => undefined,
    });
    client.emit("authenticated");
    client.emit("message", textFrame({ text: { content: "/pair 123456" } }));
    expect((await pairing).operatorUserId).toBe("user-1");
  });
});

describe("wecom inbound messages", () => {
  test("normalizes direct text and preserves the reply request id", () => {
    const parsed = parseWecomInboundFrame(textFrame());
    expect(parsed).toMatchObject({
      id: "msg-1",
      reqId: "req-1",
      senderId: "user-1",
      conversationId: "user-1",
      chatType: "direct",
      text: "hello",
    });
    const message = toWecomChannelInboundMessage(parsed!, [], "bot-1");
    expect(message.conversation).toMatchObject({
      channelId: "wecom",
      recipientId: "user-1",
      opaqueRef: "req-1",
      metadata: { chatType: "direct", messageId: "msg-1" },
    });
  });

  test("rewrites legacy remote-channel wording before it reaches WeCom", () => {
    expect(
      formatWecomVisibleText('WeChat /resume requires the managed "wechat-codex" client.'),
    ).toBe('WeCom /resume requires the managed "wecom-codex" client.');
  });

  test("normalizes group mixed messages and quoted files", () => {
    const parsed = parseWecomInboundFrame(
      textFrame({
        chattype: "group",
        chatid: "group-1",
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "group text" } },
            { msgtype: "image", image: { url: "https://example/image", aeskey: "key" } },
          ],
        },
        quote: {
          msgtype: "file",
          file: { url: "https://example/file", aeskey: "file-key" },
        },
      }),
    );
    expect(parsed).toMatchObject({
      conversationId: "group-1",
      chatType: "group",
      text: "group text",
    });
    expect(parsed?.attachments).toEqual([
      { kind: "image", url: "https://example/image", aesKey: "key" },
      { kind: "file", url: "https://example/file", aesKey: "file-key" },
    ]);
  });

  test("claims each message only once and reclaims stale files", () => {
    const claimsDir = makeTempDir();
    const nowMs = Date.now();
    expect(tryClaimChannelInboundMessage("bot|msg", { claimsDir, nowMs })).toBe(
      true,
    );
    expect(tryClaimChannelInboundMessage("bot|msg", { claimsDir, nowMs: nowMs + 1 })).toBe(
      false,
    );
    expect(
      tryClaimChannelInboundMessage("bot|msg", {
        claimsDir,
        nowMs: nowMs + 11 * 60 * 1000,
        ttlMs: 10 * 60 * 1000,
      }),
    ).toBe(true);
  });

  test("downloads and decrypts inbound media before the URL expires", async () => {
    const key = crypto.randomBytes(32);
    const plain = Buffer.from("encrypted attachment payload", "utf-8");
    const paddingLength = 32 - (plain.length % 32);
    const padded = Buffer.concat([
      plain,
      Buffer.alloc(paddingLength, paddingLength),
    ]);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

    const attachment = await downloadWecomAttachment(
      {
        kind: "file",
        url: "https://example.invalid/file",
        aesKey: key.toString("base64"),
      },
      {
        messageId: "msg-encrypted",
        index: 0,
        attachmentsDir: makeTempDir(),
        fetchImpl: async () =>
          new Response(encrypted, {
            status: 200,
            headers: {
              "content-type": "text/plain",
              "content-disposition": "attachment; filename=note.txt",
            },
          }),
      },
    );

    expect(attachment.fileName).toBe("note.txt");
    expect(fs.readFileSync(attachment.path, "utf-8")).toBe(plain.toString("utf-8"));
  });
});

describe("wecom transport output", () => {
  function createTransport(client: FakeWecomClient): WecomTransport {
    const transport = new WecomTransport({
      account,
      clientFactory: () => client,
      claimsDir: makeTempDir(),
      attachmentsDir: makeTempDir(),
    });
    transport.start();
    client.emit("authenticated");
    return transport;
  }

  test("uses one reply stream for thinking and final output", async () => {
    const client = new FakeWecomClient();
    const transport = createTransport(client);
    const target = {
      channelId: "wecom",
      conversationId: "user-1",
      recipientId: "user-1",
      opaqueRef: "req-1",
      metadata: { chatType: "direct" },
    };
    await transport.sendText(target, "working", "thinking");
    await transport.sendText(target, "done", "final_reply");
    expect(client.replyStreamCalls).toHaveLength(2);
    expect(client.replyStreamCalls[0]?.streamId).toBe(client.replyStreamCalls[1]?.streamId);
    expect(client.replyStreamCalls[1]).toMatchObject({ text: "done", finish: true });
  });

  test("falls back to active messaging when the final stream is rejected", async () => {
    const client = new FakeWecomClient();
    const transport = createTransport(client);
    client.failNextReply = true;
    await transport.sendText(
      {
        channelId: "wecom",
        conversationId: "group-1",
        recipientId: "group-1",
        opaqueRef: "req-1",
        metadata: { chatType: "group" },
      },
      "final",
      "final_reply",
    );
    expect(client.activeMessages).toEqual([
      {
        chatId: "group-1",
        body: { msgtype: "markdown", markdown: { content: "final" } },
      },
    ]);
  });

  test("downgrades unsupported image formats to a file upload", async () => {
    const client = new FakeWecomClient();
    const transport = createTransport(client);
    const filePath = path.join(makeTempDir(), "diagram.svg");
    fs.writeFileSync(filePath, "<svg/>");
    await transport.sendAttachment(
      {
        channelId: "wecom",
        conversationId: "user-1",
        recipientId: "user-1",
      },
      { kind: "image", path: filePath, mimeType: "image/svg+xml" },
    );
    expect(client.uploads[0]?.options.type).toBe("file");
    expect(client.mediaMessages[0]).toMatchObject({ type: "file", chatId: "user-1" });
  });

  test("rejects unpaired senders before dispatching their message", async () => {
    const client = new FakeWecomClient();
    const transport = createTransport(client);
    const unauthorized: string[] = [];
    const delivered: string[] = [];
    transport.setHandlers({
      onMessage: (message) => delivered.push(message.id),
      onUnauthorized: (senderId) => unauthorized.push(senderId),
    });

    client.emit("message", textFrame({ from: { userid: "user-2" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unauthorized).toEqual(["user-2"]);
    expect(delivered).toEqual([]);
  });

  test("serializes messages from the same conversation", async () => {
    const client = new FakeWecomClient();
    const transport = createTransport(client);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      transport.setHandlers({
        onMessage: async (message) => {
          order.push(`start:${message.id}`);
          if (message.id === "msg-1") {
            await firstGate;
          }
          order.push(`end:${message.id}`);
          if (message.id === "msg-2") {
            resolve();
          }
        },
      });
    });

    client.emit("message", textFrame({ msgid: "msg-1" }));
    client.emit("message", textFrame({ msgid: "msg-2" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start:msg-1"]);
    releaseFirst();
    await delivered;
    expect(order).toEqual([
      "start:msg-1",
      "end:msg-1",
      "start:msg-2",
      "end:msg-2",
    ]);
  });

  test("treats a server duplicate-connection event as fatal without reconnecting", async () => {
    const client = new FakeWecomClient();
    const transport = createTransport(client);
    const fatal = new Promise<string>((resolve) => {
      transport.setHandlers({
        onMessage: () => undefined,
        onFatal: (error) => resolve(error.message),
      });
    });

    client.emit("event.disconnected_event", textFrame());
    expect(await fatal).toContain("connected by another process");
    expect(client.isConnected).toBe(false);
  });
});
