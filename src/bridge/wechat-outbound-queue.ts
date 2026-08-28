import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getWorkspaceChannelPaths } from "../wechat/channel-config.ts";
import { writeJsonFileAtomic } from "../utils/atomic-file.ts";
import type { WechatSendContext } from "./wechat-forwarding.ts";

export type PendingWechatMessage = {
  id: string;
  recipientId: string;
  text: string;
  context: WechatSendContext;
  queuedAt: string;
};

type PendingWechatMessageFile = {
  messages?: unknown;
};

export function getPendingWechatMessagesFile(cwd: string): string {
  return path.join(
    getWorkspaceChannelPaths(cwd).workspaceDir,
    "pending-wechat-messages.json",
  );
}

function readPendingMessages(filePath: string): PendingWechatMessage[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PendingWechatMessageFile;
    if (!Array.isArray(parsed.messages)) {
      return [];
    }
    return parsed.messages.filter((message): message is PendingWechatMessage => {
      return (
        Boolean(message) &&
        typeof message === "object" &&
        typeof (message as PendingWechatMessage).id === "string" &&
        typeof (message as PendingWechatMessage).recipientId === "string" &&
        typeof (message as PendingWechatMessage).text === "string" &&
        typeof (message as PendingWechatMessage).context === "string" &&
        typeof (message as PendingWechatMessage).queuedAt === "string"
      );
    });
  } catch {
    return [];
  }
}

export class PendingWechatMessageStore {
  private readonly filePath: string;
  private messages: PendingWechatMessage[];

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.messages = readPendingMessages(filePath);
  }

  list(): PendingWechatMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  enqueue(
    recipientId: string,
    text: string,
    context: WechatSendContext,
  ): PendingWechatMessage | null {
    const normalizedRecipientId = recipientId.trim();
    const normalizedText = text.trim();
    if (!normalizedRecipientId || !normalizedText) {
      return null;
    }

    const message: PendingWechatMessage = {
      id: crypto.randomUUID(),
      recipientId: normalizedRecipientId,
      text: normalizedText,
      context,
      queuedAt: new Date().toISOString(),
    };
    this.messages.push(message);
    this.persist();
    return { ...message };
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
