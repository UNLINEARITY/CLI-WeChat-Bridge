import fs from "node:fs";
import path from "node:path";

import {
  generateReqId,
  WSAuthFailureError,
  WSClient,
  WSReconnectExhaustedError,
  type BaseMessage,
  type SendMsgBody,
  type UploadMediaFinishResult,
  type UploadMediaOptions,
  type WeComMediaType,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";

import type {
  ChannelAttachment,
  ChannelConversationRef,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import { tryClaimChannelInboundMessage } from "../../core/inbound-message-claims.ts";
import {
  downloadWecomInboundAttachments,
} from "./wecom-media.ts";
import {
  parseWecomInboundFrame,
  toWecomChannelInboundMessage,
} from "./wecom-message.ts";
import {
  WECOM_INBOUND_MESSAGE_CLAIMS_DIR,
  type StoredWecomAccount,
} from "./wecom-config.ts";
import type { ChannelInboundMessage } from "../../core/channel-types.ts";

const WECOM_TEXT_MAX_BYTES = 20_480;
const WECOM_TEXT_CHUNK_BYTES = 18_000;
const WECOM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const WECOM_VIDEO_MAX_BYTES = 10 * 1024 * 1024;
const WECOM_VOICE_MAX_BYTES = 2 * 1024 * 1024;
const WECOM_FILE_MAX_BYTES = 20 * 1024 * 1024;

export type WecomTransportLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WecomSdkClient = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): unknown;
  disconnect(): void;
  readonly isConnected: boolean;
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<WsFrame>;
  replyStreamNonBlocking(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<WsFrame | "skipped">;
  sendMessage(chatId: string, body: SendMsgBody): Promise<WsFrame>;
  uploadMedia(
    fileBuffer: Buffer,
    options: UploadMediaOptions,
  ): Promise<UploadMediaFinishResult>;
  sendMediaMessage(
    chatId: string,
    mediaType: WeComMediaType,
    mediaId: string,
    videoOptions?: { title?: string; description?: string },
  ): Promise<WsFrame>;
};

export type WecomTransportOptions = {
  account: StoredWecomAccount;
  clientFactory?: (account: StoredWecomAccount, logger: WecomTransportLogger) => WecomSdkClient;
  logger?: WecomTransportLogger;
  claimsDir?: string;
  attachmentsDir?: string;
  fetchImpl?: typeof fetch;
};

type WecomStreamState = {
  streamId: string;
  finished: boolean;
};

function createDefaultClient(
  account: StoredWecomAccount,
  logger: WecomTransportLogger,
): WecomSdkClient {
  return new WSClient({
    botId: account.botId,
    secret: account.secret,
    maxReconnectAttempts: 10,
    maxAuthFailureAttempts: 5,
    heartbeatInterval: 30_000,
    maxReplyQueueSize: 500,
    logger: {
      debug: (message, ...args) => logger.log?.(`[wecom-sdk] ${message} ${args.join(" ")}`.trim()),
      info: (message, ...args) => logger.log?.(`[wecom-sdk] ${message} ${args.join(" ")}`.trim()),
      warn: (message, ...args) => logger.log?.(`[wecom-sdk] WARN: ${message} ${args.join(" ")}`.trim()),
      error: (message, ...args) => logger.error?.(`[wecom-sdk] ${message} ${args.join(" ")}`.trim()),
    },
  });
}

function splitUtf8Text(text: string, maxBytes = WECOM_TEXT_CHUNK_BYTES): string[] {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf-8");
    if (current && bytes + nextBytes > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += nextBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function getChatType(target: ChannelConversationRef): "direct" | "group" {
  return target.metadata?.chatType === "group" ? "group" : "direct";
}

function getReplyFrame(target: ChannelConversationRef): WsFrameHeaders | null {
  return target.opaqueRef
    ? { headers: { req_id: target.opaqueRef } }
    : null;
}

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".amr": "audio/amr",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
  };
  return known[ext] || "application/octet-stream";
}

function resolveOutboundMedia(
  attachment: ChannelAttachment,
): { type: WeComMediaType; maxBytes: number; fileName: string } {
  const fileName = attachment.fileName || path.basename(attachment.path);
  const size = fs.statSync(attachment.path).size;
  const mimeType = attachment.mimeType || inferMimeType(attachment.path);
  if (
    attachment.kind === "image" &&
    size <= WECOM_IMAGE_MAX_BYTES &&
    ["image/jpeg", "image/png", "image/gif"].includes(mimeType)
  ) {
    return { type: "image", maxBytes: WECOM_IMAGE_MAX_BYTES, fileName };
  }
  if (
    attachment.kind === "voice" &&
    size <= WECOM_VOICE_MAX_BYTES &&
    path.extname(fileName).toLowerCase() === ".amr"
  ) {
    return { type: "voice", maxBytes: WECOM_VOICE_MAX_BYTES, fileName };
  }
  if (
    attachment.kind === "video" &&
    size <= WECOM_VIDEO_MAX_BYTES &&
    path.extname(fileName).toLowerCase() === ".mp4"
  ) {
    return { type: "video", maxBytes: WECOM_VIDEO_MAX_BYTES, fileName };
  }
  return { type: "file", maxBytes: WECOM_FILE_MAX_BYTES, fileName };
}

export class WecomTransport {
  readonly account: StoredWecomAccount;
  private readonly client: WecomSdkClient;
  private readonly logger: WecomTransportLogger;
  private readonly claimsDir: string;
  private readonly attachmentsDir?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly streamStates = new Map<string, WecomStreamState>();
  private readonly inboundChains = new Map<string, Promise<void>>();
  private outputChain = Promise.resolve();
  private authenticated = false;
  private started = false;
  private onMessage: ((message: ChannelInboundMessage) => void | Promise<void>) | null = null;
  private onUnauthorized: ((senderId: string, chatType: "direct" | "group") => void | Promise<void>) | null = null;
  private onFatal: ((error: Error) => void | Promise<void>) | null = null;
  private onConnected: (() => void | Promise<void>) | null = null;

  constructor(options: WecomTransportOptions) {
    this.account = options.account;
    this.logger = options.logger ?? {};
    this.claimsDir = options.claimsDir ?? WECOM_INBOUND_MESSAGE_CLAIMS_DIR;
    this.attachmentsDir = options.attachmentsDir;
    this.fetchImpl = options.fetchImpl;
    this.client = (options.clientFactory ?? createDefaultClient)(this.account, this.logger);
    this.attachClientEvents();
  }

  private attachClientEvents(): void {
    this.client.on("authenticated", () => {
      this.authenticated = true;
      this.logger.log?.("wecom_authenticated");
      void this.onConnected?.();
    });
    this.client.on("disconnected", (reason: string) => {
      this.authenticated = false;
      this.logger.log?.(`wecom_disconnected: reason=${reason}`);
    });
    this.client.on("reconnecting", (attempt: number) => {
      this.logger.log?.(`wecom_reconnecting: attempt=${attempt}`);
    });
    this.client.on("event.disconnected_event", () => {
      const error = new Error(
        "The WeCom bot was connected by another process. This connection was stopped to avoid a reconnect loop.",
      );
      this.authenticated = false;
      this.client.disconnect();
      void this.onFatal?.(error);
    });
    this.client.on("error", (error: Error) => {
      this.logger.error?.(`wecom_transport_error: ${error.message}`);
      if (
        error instanceof WSAuthFailureError ||
        error instanceof WSReconnectExhaustedError
      ) {
        void this.onFatal?.(error);
      }
    });
    this.client.on("message", (frame: WsFrame<BaseMessage>) => {
      void this.handleInboundFrame(frame).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error?.(`wecom_inbound_failed: ${message}`);
      });
    });
  }

  setHandlers(handlers: {
    onMessage: (message: ChannelInboundMessage) => void | Promise<void>;
    onUnauthorized?: (senderId: string, chatType: "direct" | "group") => void | Promise<void>;
    onFatal?: (error: Error) => void | Promise<void>;
    onConnected?: () => void | Promise<void>;
  }): void {
    this.onMessage = handlers.onMessage;
    this.onUnauthorized = handlers.onUnauthorized ?? null;
    this.onFatal = handlers.onFatal ?? null;
    this.onConnected = handlers.onConnected ?? null;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.client.connect();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.authenticated = false;
    this.streamStates.clear();
    this.client.disconnect();
  }

  get isConnected(): boolean {
    return this.authenticated && this.client.isConnected;
  }

  async waitUntilConnected(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnected) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for WeCom WebSocket authentication.");
  }

  private async handleInboundFrame(frame: WsFrame<BaseMessage>): Promise<void> {
    const parsed = parseWecomInboundFrame(frame);
    if (!parsed) {
      return;
    }
    if (parsed.senderId !== this.account.operatorUserId) {
      await this.onUnauthorized?.(parsed.senderId, parsed.chatType);
      return;
    }
    if (
      !tryClaimChannelInboundMessage(`${this.account.botId}|${parsed.id}`, {
        claimsDir: this.claimsDir,
      })
    ) {
      this.logger.log?.(`wecom_duplicate_skipped: msgid=${parsed.id}`);
      return;
    }

    const queueKey = `${this.account.botId}:${parsed.conversationId}`;
    const previous = this.inboundChains.get(queueKey) ?? Promise.resolve();
    const deliver = async () => {
      const downloaded = await downloadWecomInboundAttachments(parsed, {
        attachmentsDir: this.attachmentsDir,
        fetchImpl: this.fetchImpl,
      });
      const text = [parsed.text, ...downloaded.failureNotes]
        .filter(Boolean)
        .join("\n")
        .trim();
      await this.onMessage?.(
        toWecomChannelInboundMessage(
          { ...parsed, text },
          downloaded.attachments,
          this.account.botId,
        ),
      );
    };
    const next = previous.then(deliver, deliver);
    this.inboundChains.set(queueKey, next);
    try {
      await next;
    } finally {
      if (this.inboundChains.get(queueKey) === next) {
        this.inboundChains.delete(queueKey);
      }
    }
  }

  private queueOutput<T>(action: () => Promise<T>): Promise<T> {
    const run = this.outputChain.then(action);
    this.outputChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendActiveText(target: ChannelConversationRef, text: string): Promise<void> {
    for (const chunk of splitUtf8Text(text)) {
      if (Buffer.byteLength(chunk, "utf-8") > WECOM_TEXT_MAX_BYTES) {
        throw new Error("WeCom text chunk exceeds the 20480-byte platform limit.");
      }
      await this.client.sendMessage(target.recipientId, {
        msgtype: "markdown",
        markdown: { content: chunk },
      });
    }
  }

  async sendText(
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ): Promise<boolean> {
    const normalized = text.trim();
    if (!normalized) {
      return true;
    }
    return this.queueOutput(async () => {
      if (!this.isConnected) {
        throw new Error("WeCom WebSocket is not connected.");
      }

      const chunks = splitUtf8Text(normalized);
      const replyFrame = getReplyFrame(target);
      const canUseStream = Boolean(replyFrame) && (kind === "thinking" || kind === "final_reply");
      if (!canUseStream) {
        await this.sendActiveText(target, normalized);
        return true;
      }

      const reqId = target.opaqueRef!;
      const state = this.streamStates.get(reqId) ?? {
        streamId: generateReqId("stream"),
        finished: false,
      };
      this.streamStates.set(reqId, state);
      try {
        if (kind === "thinking") {
          const result = await this.client.replyStreamNonBlocking(
            replyFrame!,
            state.streamId,
            chunks[0]!,
            false,
          );
          return result !== "skipped";
        }

        await this.client.replyStream(replyFrame!, state.streamId, chunks[0]!, true);
        state.finished = true;
        this.streamStates.delete(reqId);
        for (const chunk of chunks.slice(1)) {
          await this.sendActiveText(target, chunk);
        }
        return true;
      } catch (error) {
        if (kind !== "final_reply") {
          throw error;
        }
        this.streamStates.delete(reqId);
        this.logger.log?.(
          `wecom_stream_fallback: reqid=${reqId} chat_type=${getChatType(target)}`,
        );
        await this.sendActiveText(target, normalized);
        return true;
      }
    });
  }

  async sendAttachment(
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ): Promise<void> {
    await this.queueOutput(async () => {
      if (!this.isConnected) {
        throw new Error("WeCom WebSocket is not connected.");
      }
      const media = resolveOutboundMedia(attachment);
      const buffer = fs.readFileSync(attachment.path);
      if (buffer.length > media.maxBytes) {
        throw new Error(
          `${media.type} attachment exceeds the ${Math.round(media.maxBytes / 1024 / 1024)} MB WeCom limit`,
        );
      }
      const uploaded = await this.client.uploadMedia(buffer, {
        type: media.type,
        filename: media.fileName,
      });
      await this.client.sendMediaMessage(
        target.recipientId,
        media.type,
        uploaded.media_id,
        media.type === "video"
          ? { title: media.fileName, description: "" }
          : undefined,
      );
    });
  }
}
