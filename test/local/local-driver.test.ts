// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  LocalChannelDriver,
  LOCAL_CHANNEL_OPERATOR_ID,
} from "../../src/channels/local/local-driver.ts";
import type { ChannelInboundMessage } from "../../src/core/channel-types.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createWorkspace(): { dir: string; inboxFile: string; transcriptFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-driver-"));
  return {
    dir,
    inboxFile: path.join(dir, "local-inbox.jsonl"),
    transcriptFile: path.join(dir, "local-transcript.jsonl"),
  };
}

function readTranscript(transcriptFile: string): Record<string, unknown>[] {
  if (!fs.existsSync(transcriptFile)) return [];
  return fs.readFileSync(transcriptFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("local channel driver", () => {
  test("records outbound text in the transcript and reports sent", async () => {
    const files = createWorkspace();
    const driver = new LocalChannelDriver({
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
    });
    const logLines: string[] = [];
    const result = await driver.sendText({
      target: driver.directConversation("local-operator"),
      text: "hello from the bridge",
      context: "final_reply",
      log: (entry) => logLines.push(entry),
    });
    expect(result).toEqual({ status: "sent" });
    const transcript = readTranscript(files.transcriptFile);
    expect(transcript).toEqual([
      expect.objectContaining({
        direction: "outbound",
        context: "final_reply",
        recipientId: "local-operator",
        text: "hello from the bridge",
      }),
    ]);
    expect(logLines[0]).toContain("local_send_completed");
  });

  test("dispatches appended inbox lines with operator defaults and custom senders", async () => {
    const files = createWorkspace();
    const driver = new LocalChannelDriver({
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
      pollIntervalMs: 20,
    });
    const messages: ChannelInboundMessage[] = [];
    driver.start({
      onInboundMessage: async (message) => {
        messages.push(message);
      },
    });
    fs.appendFileSync(files.inboxFile, `${JSON.stringify({ text: "default hello" })}\n`);
    await delay(150);
    fs.appendFileSync(
      files.inboxFile,
      `${JSON.stringify({
        text: "group hello",
        senderId: "bob",
        conversationId: "room-1",
        attachments: [{ kind: "image", path: "/tmp/a.png", fileName: "a.png" }],
      })}\n`,
    );
    fs.appendFileSync(files.inboxFile, "not json\n");
    fs.appendFileSync(files.inboxFile, `${JSON.stringify({ senderId: "bob" })}\n`);
    await delay(200);
    driver.stop();

    expect(messages.map((message) => message.text)).toEqual(["default hello", "group hello"]);
    expect(messages[0]!.senderId).toBe(LOCAL_CHANNEL_OPERATOR_ID);
    expect(messages[0]!.conversation.channelId).toBe("local");
    expect(messages[0]!.conversation.conversationId).toBe(LOCAL_CHANNEL_OPERATOR_ID);
    expect(messages[1]!.senderId).toBe("bob");
    expect(messages[1]!.conversation.conversationId).toBe("room-1");
    expect(messages[1]!.attachments).toEqual([
      { kind: "image", path: "/tmp/a.png", fileName: "a.png" },
    ]);

    const transcript = readTranscript(files.transcriptFile);
    expect(transcript).toEqual([
      expect.objectContaining({ direction: "inbound", context: "inbound", text: "default hello" }),
      expect.objectContaining({ direction: "inbound", text: "group hello", recipientId: "bob" }),
    ]);
  });

  test("waits for complete lines and ignores inbox content from before start", async () => {
    const files = createWorkspace();
    fs.appendFileSync(files.inboxFile, `${JSON.stringify({ text: "stale" })}\n`);
    const driver = new LocalChannelDriver({
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
      pollIntervalMs: 20,
    });
    const messages: string[] = [];
    driver.start({
      onInboundMessage: async (message) => {
        messages.push(message.text);
      },
    });
    await delay(100);
    expect(messages).toEqual([]);

    fs.appendFileSync(files.inboxFile, '{"text":"part');
    await delay(100);
    expect(messages).toEqual([]);

    fs.appendFileSync(files.inboxFile, 'ial"}\n');
    await delay(150);
    driver.stop();
    expect(messages).toEqual(["partial"]);
  });

  test("recovers when the inbox file is truncated", async () => {
    const files = createWorkspace();
    const driver = new LocalChannelDriver({
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
      pollIntervalMs: 20,
    });
    const messages: string[] = [];
    driver.start({
      onInboundMessage: async (message) => {
        messages.push(message.text);
      },
    });
    fs.appendFileSync(files.inboxFile, `${JSON.stringify({ text: "first-aaaaaaaaaaaa" })}\n`);
    await delay(150);

    fs.writeFileSync(files.inboxFile, `${JSON.stringify({ text: "second" })}\n`);
    await delay(150);
    driver.stop();
    expect(messages).toEqual(["first-aaaaaaaaaaaa", "second"]);
  });

  test("stops dispatching after stop()", async () => {
    const files = createWorkspace();
    const driver = new LocalChannelDriver({
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
      pollIntervalMs: 20,
    });
    const messages: string[] = [];
    driver.start({
      onInboundMessage: async (message) => {
        messages.push(message.text);
      },
    });
    driver.stop();
    fs.appendFileSync(files.inboxFile, `${JSON.stringify({ text: "ignored" })}\n`);
    await delay(120);
    expect(messages).toEqual([]);
  });

  test("builds prompts with attachment paths and exposes loopback conversations", () => {
    const files = createWorkspace();
    const driver = new LocalChannelDriver({
      operatorId: LOCAL_CHANNEL_OPERATOR_ID,
      inboxFile: files.inboxFile,
      transcriptFile: files.transcriptFile,
    });
    expect(driver.id).toBe("local");
    expect(driver.capabilities).toEqual({
      streamingReplies: false,
      outboundAttachments: false,
      multiConversation: false,
      pushInbound: true,
    });
    expect(driver.defaultConversation()).toEqual(driver.directConversation(LOCAL_CHANNEL_OPERATOR_ID));
    expect(driver.buildInboundPrompt("hello", [])).toBe("hello");
    expect(driver.buildInboundPrompt("hello", [
      { kind: "file", path: "/tmp/report.pdf", fileName: "report.pdf" },
      { kind: "image", path: "/tmp/b.png" },
    ])).toBe("hello\n\nLocal attachments:\n- /tmp/report.pdf (report.pdf)\n- /tmp/b.png");
  });
});
