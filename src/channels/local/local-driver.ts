// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import path from "node:path";

import type {
  ChannelAttachment,
  ChannelConversationRef,
  ChannelInboundMessage,
  WechatSendContext,
} from "../../core/channel-types.ts";
import type {
  ChannelDriver,
  ChannelDriverInboundHandlers,
  ChannelSendResult,
} from "../../core/channel-driver.ts";
import { getWorkspaceChannelPaths } from "../../wechat/channel-config.ts";

/**
 * Loopback channel for local end-to-end runs. Inbound messages are JSONL
 * lines appended to the inbox file; every outbound text is appended to the
 * transcript file so an external harness can drive and observe the full
 * bridge pipeline without a remote messaging platform.
 */
export const LOCAL_CHANNEL_OPERATOR_ID = "local-operator";

export type LocalChannelFiles = {
  inboxFile: string;
  transcriptFile: string;
};

export function getLocalChannelFiles(cwd: string): LocalChannelFiles {
  const workspaceDir = getWorkspaceChannelPaths(cwd).workspaceDir;
  return {
    inboxFile: path.join(workspaceDir, "local-inbox.jsonl"),
    transcriptFile: path.join(workspaceDir, "local-transcript.jsonl"),
  };
}

/** One appended line in the local inbox file. */
export type LocalInboundLine = {
  text: string;
  senderId?: string;
  conversationId?: string;
  attachments?: ChannelAttachment[];
};

export type LocalChannelDriverOptions = {
  operatorId: string;
  inboxFile: string;
  transcriptFile: string;
  /** Inbox poll interval; tests use small values. */
  pollIntervalMs?: number;
  log?: (message: string) => void;
};

export class LocalChannelDriver implements ChannelDriver {
  readonly id = "local";
  readonly displayName = "Local";
  readonly operatorDescription = "the local operator";
  readonly capabilities = {
    streamingReplies: false,
    outboundAttachments: false,
    multiConversation: false,
    pushInbound: true,
  } as const;

  private readonly operatorId: string;
  private readonly inboxFile: string;
  private readonly transcriptFile: string;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;
  private handlers: ChannelDriverInboundHandlers | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inboxOffset = 0;
  private pendingLine = "";
  private messageSeq = 0;

  constructor(options: LocalChannelDriverOptions) {
    this.operatorId = options.operatorId;
    this.inboxFile = options.inboxFile;
    this.transcriptFile = options.transcriptFile;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.log = options.log ?? (() => {});
  }

  defaultConversation(): ChannelConversationRef {
    return this.directConversation(this.operatorId);
  }

  directConversation(senderId: string): ChannelConversationRef {
    return {
      channelId: "local",
      conversationId: senderId,
      recipientId: senderId,
      metadata: { chatType: "direct" },
    };
  }

  start(handlers: ChannelDriverInboundHandlers): void {
    this.handlers = handlers;
    fs.mkdirSync(path.dirname(this.inboxFile), { recursive: true });
    // Start at end-of-file so lines left over from earlier runs are ignored.
    this.inboxOffset = this.measureInboxSize();
    this.pendingLine = "";
    this.timer = setInterval(() => {
      void this.pumpInbox();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.log("local_channel_started");
  }

  /** Clears the inbox watcher. Not part of ChannelDriver; callers may stop explicitly. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
    this.handlers = null;
  }

  waitUntilReady(): Promise<void> {
    return Promise.resolve();
  }

  async sendText(params: {
    target: ChannelConversationRef;
    text: string;
    context: WechatSendContext;
    log: (entry: string) => void;
  }): Promise<ChannelSendResult> {
    const { target, text, context, log } = params;
    this.appendTranscript({
      ts: new Date().toISOString(),
      direction: "outbound",
      context,
      conversationId: target.conversationId,
      recipientId: target.recipientId,
      text,
    });
    log(
      `local_send_completed: context=${context} recipient=${target.recipientId} chars=${Array.from(text).length}`,
    );
    return { status: "sent" };
  }

  buildInboundPrompt(text: string, attachments: ChannelAttachment[]): string {
    if (attachments.length === 0) {
      return text;
    }
    const lines = attachments.map((attachment) => {
      const label = attachment.fileName ? ` (${attachment.fileName})` : "";
      return `- ${attachment.path}${label}`;
    });
    return `${text}\n\nLocal attachments:\n${lines.join("\n")}`;
  }

  private measureInboxSize(): number {
    try {
      return fs.statSync(this.inboxFile).size;
    } catch {
      return 0;
    }
  }

  private async pumpInbox(): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) {
      return;
    }
    let size: number;
    try {
      size = fs.statSync(this.inboxFile).size;
    } catch {
      return;
    }
    if (size < this.inboxOffset) {
      // The inbox was truncated; restart from the beginning.
      this.inboxOffset = 0;
      this.pendingLine = "";
    }
    if (size === this.inboxOffset) {
      return;
    }
    let chunk: string;
    try {
      const fd = fs.openSync(this.inboxFile, "r");
      try {
        const buffer = Buffer.alloc(size - this.inboxOffset);
        fs.readSync(fd, buffer, 0, buffer.length, this.inboxOffset);
        chunk = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    this.inboxOffset = size;
    const complete = chunk.endsWith("\n");
    const combined = this.pendingLine + chunk;
    const parts = combined.split("\n");
    this.pendingLine = complete ? "" : (parts.pop() ?? "");
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        await this.dispatchInboxLine(trimmed, handlers);
      } catch (error) {
        this.log(
          `local_inbound_failed: error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async dispatchInboxLine(
    line: string,
    handlers: ChannelDriverInboundHandlers,
  ): Promise<void> {
    let parsed: LocalInboundLine;
    try {
      parsed = JSON.parse(line) as LocalInboundLine;
    } catch {
      this.log("local_inbox_invalid_json: skipped one line");
      return;
    }
    if (typeof parsed?.text !== "string" || !parsed.text.trim()) {
      this.log("local_inbox_invalid_line: skipped one line without text");
      return;
    }
    const senderId =
      typeof parsed.senderId === "string" && parsed.senderId
        ? parsed.senderId
        : this.operatorId;
    const conversationId =
      typeof parsed.conversationId === "string" && parsed.conversationId
        ? parsed.conversationId
        : senderId;
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(
          (attachment): attachment is ChannelAttachment =>
            Boolean(attachment) &&
            typeof attachment.path === "string" &&
            typeof attachment.kind === "string",
        )
      : [];
    this.messageSeq += 1;
    const message: ChannelInboundMessage = {
      id: `local-${Date.now().toString(36)}-${this.messageSeq}`,
      conversation: { ...this.directConversation(senderId), conversationId },
      senderId,
      text: parsed.text,
      attachments,
      createdAt: new Date().toISOString(),
    };
    this.appendTranscript({
      ts: message.createdAt,
      direction: "inbound",
      context: "inbound",
      conversationId,
      recipientId: senderId,
      text: parsed.text,
    });
    await handlers.onInboundMessage(message);
  }

  private appendTranscript(record: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.transcriptFile), { recursive: true });
    fs.appendFileSync(this.transcriptFile, `${JSON.stringify(record)}\n`, "utf8");
  }
}
