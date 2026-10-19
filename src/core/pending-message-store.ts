// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getWorkspaceChannelPaths } from "../wechat/channel-config.ts";
import { writeJsonFileAtomic } from "../utils/atomic-file.ts";
import type {
  BridgeChannelId,
  ChannelConversationRef,
  ChannelSendKind,
} from "./channel-types.ts";

export type PendingMessage = {
  id: string;
  recipientId: string;
  text: string;
  context: ChannelSendKind;
  queuedAt: string;
  target?: ChannelConversationRef;
};

type PendingMessageFile = {
  messages?: unknown;
};

/** Contexts worth redelivering after the channel recovers. */
const PENDING_WORTHY_CONTEXTS = new Set<ChannelSendKind>([
  "final_reply",
  "approval_required",
  "user_input_required",
  "task_failed",
  "fatal_error",
]);

/** Drop queued messages older than this — stale replies are noise, not value. */
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;
/** Cap the backlog so one recovery never floods the chat. */
const PENDING_MAX_MESSAGES = 10;

function isExpired(message: PendingMessage, now = Date.now()): boolean {
  const queuedAtMs = Date.parse(message.queuedAt);
  if (!Number.isFinite(queuedAtMs)) {
    return true;
  }
  return now - queuedAtMs > PENDING_MAX_AGE_MS;
}

export function getPendingChannelMessagesFile(
  cwd: string,
  channelId: BridgeChannelId,
): string {
  return path.join(
    getWorkspaceChannelPaths(cwd).workspaceDir,
    `pending-${channelId}-messages.json`,
  );
}

function readPendingMessages(filePath: string): PendingMessage[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PendingMessageFile;
    if (!Array.isArray(parsed.messages)) {
      return [];
    }
    return parsed.messages.filter((message): message is PendingMessage => {
      return (
        Boolean(message) &&
        typeof message === "object" &&
        typeof (message as PendingMessage).id === "string" &&
        typeof (message as PendingMessage).recipientId === "string" &&
        typeof (message as PendingMessage).text === "string" &&
        typeof (message as PendingMessage).context === "string" &&
        typeof (message as PendingMessage).queuedAt === "string"
      );
    });
  } catch {
    return [];
  }
}

export class PendingMessageStore {
  private readonly filePath: string;
  private messages: PendingMessage[];

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.messages = readPendingMessages(filePath);
  }

  list(): PendingMessage[] {
    this.compact();
    return this.messages.map((message) => ({
      ...message,
      target: message.target ? { ...message.target } : undefined,
    }));
  }

  enqueue(
    recipientId: string,
    text: string,
    context: ChannelSendKind,
    target?: ChannelConversationRef,
  ): PendingMessage | null {
    const normalizedRecipientId = recipientId.trim();
    const normalizedText = text.trim();
    if (!normalizedRecipientId || !normalizedText) {
      return null;
    }
    if (!PENDING_WORTHY_CONTEXTS.has(context)) {
      return null;
    }

    const message: PendingMessage = {
      id: crypto.randomUUID(),
      recipientId: normalizedRecipientId,
      text: normalizedText,
      context,
      queuedAt: new Date().toISOString(),
      target: target ? { ...target } : undefined,
    };
    this.messages.push(message);
    this.compact();
    this.persist();
    return { ...message };
  }

  /** Drop expired entries and trim the backlog to the cap (oldest first). */
  private compact(): void {
    const now = Date.now();
    const fresh = this.messages.filter((message) => !isExpired(message, now));
    while (fresh.length > PENDING_MAX_MESSAGES) {
      fresh.shift();
    }
    this.messages = fresh;
  }

  remove(id: string): boolean {
    const next = this.messages.filter((message) => message.id !== id);
    if (next.length === this.messages.length) {
      return false;
    }
    this.messages = next;
    this.persist();
    return true;
  }

  private persist(): void {
    writeJsonFileAtomic(this.filePath, { messages: this.messages });
  }
}
