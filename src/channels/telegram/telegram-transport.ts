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
  ChannelAttachmentKind,
  ChannelConversationRef,
  ChannelInboundMessage,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import { tryClaimChannelInboundMessage } from "../../core/inbound-message-claims.ts";
import { truncatePreview } from "../../core/text-utils.ts";
import {
  TELEGRAM_INBOUND_ATTACHMENTS_DIR,
  TELEGRAM_INBOUND_MESSAGE_CLAIMS_DIR,
  type StoredTelegramAccount,
} from "./telegram-config.ts";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TEXT_CHUNK_CHARS = 3_900;
const TELEGRAM_LONG_POLL_TIMEOUT_S = 50;
const TELEGRAM_TYPING_REFRESH_MS = 4_000;
const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type TelegramTransportLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type TelegramTransportHandlers = {
  onMessage: (message: ChannelInboundMessage) => Promise<void>;
  onUnauthorized?: (senderId: string, chatType: string) => Promise<void>;
  onFatal?: (error: Error) => Promise<void>;
  onConnected?: () => Promise<void>;
  /**
   * Raw text hook fired for every message before the authorization gate.
   * Used by the pairing flow, which cannot know the operator id up front.
   */
  onPreAuthMessage?: (message: {
    chatId: string;
    userId: string;
    chatType: string;
    text: string;
  }) => Promise<void>;
};

export type TelegramTransportOptions = {
  account: StoredTelegramAccount;
  logger?: TelegramTransportLogger;
  claimsDir?: string;
  attachmentsDir?: string;
  fetchImpl?: typeof fetch;
};

type TelegramApiResult = {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
};

export class TelegramTokenRejectedError extends Error {
  constructor(description: string) {
    super(`Telegram rejected the bot token: ${description}`);
    this.name = "TelegramTokenRejectedError";
  }
}

export class TelegramPollConflictError extends Error {
  constructor() {
    super(
      "Another process is polling the same Telegram bot (409 conflict). Only one bridge per bot token may run.",
    );
    this.name = "TelegramPollConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function splitText(text: string, maxChars = TELEGRAM_TEXT_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current && current.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function chatTypeOf(chat: Record<string, unknown>): string {
  return typeof chat.type === "string" ? chat.type : "private";
}

function inferAttachmentKind(fileName: string, mimeType?: string): ChannelAttachmentKind {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "voice";
  const ext = path.extname(fileName).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".ogg", ".oga", ".mp3", ".m4a", ".opus"].includes(ext)) return "voice";
  return "file";
}

/** Long-poll Bot API transport for the Telegram channel. */
export class TelegramTransport {
  private readonly account: StoredTelegramAccount;
  private readonly logger: TelegramTransportLogger;
  private readonly claimsDir: string;
  private readonly attachmentsDir: string;
  private readonly fetchImpl: typeof fetch;
  private handlers: TelegramTransportHandlers | null = null;
  private polling = false;
  private pollAbort: AbortController | null = null;
  private updateOffset = 0;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private connectedNotified = false;

  constructor(options: TelegramTransportOptions) {
    this.account = options.account;
    this.logger = options.logger ?? {};
    this.claimsDir = options.claimsDir ?? TELEGRAM_INBOUND_MESSAGE_CLAIMS_DIR;
    this.attachmentsDir = options.attachmentsDir ?? TELEGRAM_INBOUND_ATTACHMENTS_DIR;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  setHandlers(handlers: TelegramTransportHandlers): void {
    this.handlers = handlers;
  }

  get isConnected(): boolean {
    return this.polling;
  }

  async start(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    void this.runPollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.endAllTyping();
  }

  private apiUrl(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${this.account.botToken}/${method}`;
  }

  private async callApi(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TelegramApiResult> {
    const response = await this.fetchImpl(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as TelegramApiResult | null;
    if (!payload) {
      throw new Error(`Telegram ${method} returned a non-JSON response (HTTP ${response.status}).`);
    }
    return payload;
  }

  private async callApiExpectOk(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const payload = await this.callApi(method, body, signal);
    if (!payload.ok) {
      if (payload.error_code === 401) {
        throw new TelegramTokenRejectedError(payload.description ?? "unauthorized");
      }
      if (payload.error_code === 409) {
        throw new TelegramPollConflictError();
      }
      throw new Error(
        `Telegram ${method} failed: ${payload.description ?? `error ${payload.error_code ?? "unknown"}`}`,
      );
    }
    return payload.result;
  }

  /** Validate the bot token and return the bot's username. */
  async validateToken(): Promise<string> {
    const result = await this.callApiExpectOk("getMe", {});
    if (!isRecord(result) || typeof result.username !== "string") {
      throw new Error("Telegram getMe returned an unexpected payload.");
    }
    return result.username;
  }

  private async runPollLoop(): Promise<void> {
    while (this.polling) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.callApiExpectOk(
          "getUpdates",
          {
            offset: this.updateOffset,
            timeout: TELEGRAM_LONG_POLL_TIMEOUT_S,
            allowed_updates: ["message"],
          },
          this.pollAbort.signal,
        );
        if (!this.connectedNotified) {
          this.connectedNotified = true;
          await this.handlers?.onConnected?.();
        }
        if (!Array.isArray(updates)) {
          continue;
        }
        for (const update of updates) {
          if (!isRecord(update)) continue;
          if (typeof update.update_id === "number") {
            this.updateOffset = update.update_id + 1;
          }
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.polling) {
          return;
        }
        if (error instanceof TelegramTokenRejectedError) {
          this.polling = false;
          this.logger.error?.(error.message);
          await this.handlers?.onFatal?.(error);
          return;
        }
        this.logger.error?.(
          `telegram_poll_error: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }

  private async handleUpdate(update: Record<string, unknown>): Promise<void> {
    const message = isRecord(update.message) ? update.message : null;
    if (!message || !isRecord(message.chat) || !isRecord(message.from)) {
      return;
    }
    const chatId = String(message.chat.id);
    const senderId = String(message.from.id);
    const chatType = chatTypeOf(message.chat);
    const messageId = typeof message.message_id === "number"
      ? String(message.message_id)
      : `${chatId}-${Date.now()}`;
    const text =
      (typeof message.text === "string" && message.text) ||
      (typeof message.caption === "string" && message.caption) ||
      "";

    if (this.handlers?.onPreAuthMessage) {
      await this.handlers.onPreAuthMessage({ chatId, userId: senderId, chatType, text });
    }

    if (senderId !== this.account.operatorUserId) {
      await this.handlers?.onUnauthorized?.(senderId, chatType);
      return;
    }

    const claimed = tryClaimChannelInboundMessage(`telegram:${chatId}:${messageId}`, {
      claimsDir: this.claimsDir,
    });
    if (!claimed) {
      return;
    }

    const attachments = await this.downloadAttachments(message);
    if (!text && attachments.length === 0) {
      return;
    }

    await this.handlers?.onMessage({
      id: messageId,
      conversation: {
        channelId: "telegram",
        conversationId: chatId,
        recipientId: chatId,
        metadata: { chatType },
      },
      senderId,
      text,
      attachments,
      createdAt: new Date().toISOString(),
    });
  }

  private async downloadAttachments(
    message: Record<string, unknown>,
  ): Promise<ChannelAttachment[]> {
    const candidates: Array<{ fileId: string; fileName: string; kind?: ChannelAttachmentKind; mimeType?: string }> = [];
    if (Array.isArray(message.photo)) {
      const largest = message.photo
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
      if (largest && typeof largest.file_id === "string") {
        candidates.push({
          fileId: largest.file_id,
          fileName: `photo-${Date.now()}.jpg`,
          kind: "image",
          mimeType: "image/jpeg",
        });
      }
    }
    if (isRecord(message.document) && typeof message.document.file_id === "string") {
      candidates.push({
        fileId: message.document.file_id,
        fileName:
          typeof message.document.file_name === "string" ? message.document.file_name : "document",
        mimeType:
          typeof message.document.mime_type === "string" ? message.document.mime_type : undefined,
      });
    }
    if (isRecord(message.video) && typeof message.video.file_id === "string") {
      candidates.push({
        fileId: message.video.file_id,
        fileName: `video-${Date.now()}.mp4`,
        kind: "video",
        mimeType: "video/mp4",
      });
    }
    if (isRecord(message.voice) && typeof message.voice.file_id === "string") {
      candidates.push({
        fileId: message.voice.file_id,
        fileName: `voice-${Date.now()}.ogg`,
        kind: "voice",
        mimeType: "audio/ogg",
      });
    }
    if (isRecord(message.audio) && typeof message.audio.file_id === "string") {
      candidates.push({
        fileId: message.audio.file_id,
        fileName:
          typeof message.audio.file_name === "string"
            ? message.audio.file_name
            : `audio-${Date.now()}.mp3`,
        kind: "voice",
      });
    }

    const attachments: ChannelAttachment[] = [];
    for (const candidate of candidates) {
      try {
        const filePath = await this.downloadFile(candidate.fileId, candidate.fileName);
        const kind = candidate.kind ?? inferAttachmentKind(candidate.fileName, candidate.mimeType);
        const sizeBytes = fs.statSync(filePath).size;
        attachments.push({
          kind,
          path: filePath,
          fileName: candidate.fileName,
          mimeType: candidate.mimeType,
          sizeBytes,
        });
      } catch (error) {
        this.logger.error?.(
          `telegram_attachment_download_failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return attachments;
  }

  private async downloadFile(fileId: string, fileName: string): Promise<string> {
    const file = await this.callApiExpectOk("getFile", { file_id: fileId });
    if (!isRecord(file) || typeof file.file_path !== "string") {
      throw new Error("Telegram getFile returned no file_path.");
    }
    const url = `${TELEGRAM_API_BASE}/file/bot${this.account.botToken}/${file.file_path}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > TELEGRAM_DOWNLOAD_MAX_BYTES) {
      throw new Error("Telegram file exceeds the 20 MB bot download limit.");
    }
    const dateDir = path.join(this.attachmentsDir, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dateDir, { recursive: true });
    const safeName = fileName.replace(/[/\\]/g, "_") || "attachment";
    const target = path.join(dateDir, `${Date.now().toString(36)}-${safeName}`);
    fs.writeFileSync(target, buffer);
    return target;
  }

  async sendText(
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ): Promise<boolean> {
    const chatId = target.recipientId;
    const chunks = splitText(text);
    for (const chunk of chunks) {
      if (!chunk) continue;
      await this.callApiExpectOk("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
    this.logger.log?.(
      `telegram_send: kind=${kind} chat=${truncatePreview(chatId, 24)} chunks=${chunks.length} chars=${text.length}`,
    );
    return true;
  }

  async sendAttachment(
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ): Promise<void> {
    const chatId = target.recipientId;
    const fileName = attachment.fileName || path.basename(attachment.path);
    const buffer = fs.readFileSync(attachment.path);
    const form = new FormData();
    form.append("chat_id", chatId);
    const blob = new Blob([new Uint8Array(buffer)]);
    const method = attachment.kind === "image" ? "sendPhoto" : "sendDocument";
    form.append(attachment.kind === "image" ? "photo" : "document", blob, fileName);
    const response = await this.fetchImpl(this.apiUrl(method), {
      method: "POST",
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as TelegramApiResult | null;
    if (!payload?.ok) {
      throw new Error(
        `Telegram ${method} failed: ${payload?.description ?? `HTTP ${response.status}`}`,
      );
    }
    this.logger.log?.(
      `telegram_attachment_sent: chat=${truncatePreview(chatId, 24)} file=${fileName}`,
    );
  }

  async beginTyping(recipientId: string): Promise<void> {
    if (this.typingTimers.has(recipientId)) {
      return;
    }
    const trigger = () => {
      void this.callApiExpectOk("sendChatAction", {
        chat_id: recipientId,
        action: "typing",
      }).catch(() => undefined);
    };
    trigger();
    this.typingTimers.set(recipientId, setInterval(trigger, TELEGRAM_TYPING_REFRESH_MS));
  }

  async endTyping(recipientId: string): Promise<void> {
    const timer = this.typingTimers.get(recipientId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(recipientId);
    }
  }

  endAllTyping(): void {
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
  }
}
