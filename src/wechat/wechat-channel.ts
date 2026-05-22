#!/usr/bin/env bun
/**
 * WeChat MCP server.
 *
 * This server exposes standard MCP tools instead of relying on
 * Claude's preview-only channel push API.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  formatByteSize,
  WeChatTransport,
  type InboundWechatMessage,
} from "./wechat-transport.ts";

const SERVER_NAME = "wechat";
const SERVER_VERSION = "0.3.0";

const DEFAULT_POLL_TIMEOUT_MS = 1_000;
const MAX_POLL_TIMEOUT_MS = 35_000;

type FetchMessagesArgs = {
  waitForNew: boolean;
  timeoutMs: number;
};

type ReplyArgs = {
  senderId: string;
  text: string;
};

type NotifyArgs = {
  message: string;
  recipientId?: string;
};

type SendImageArgs = {
  imagePath: string;
  caption?: string;
  recipientId?: string;
};

type SendFileArgs = {
  filePath: string;
  title?: string;
  recipientId?: string;
};

type SendVoiceArgs = {
  voicePath: string;
  recipientId?: string;
};

type SendVideoArgs = {
  videoPath: string;
  title?: string;
  recipientId?: string;
};

type ResetSyncArgs = {
  clearContextCache: boolean;
};

function log(message: string): void {
  process.stderr.write(`[wechat-mcp] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-mcp] ERROR: ${message}\n`);
}

const transport = new WeChatTransport({ log, logError });

function asObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function clampTimeoutMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallbackMs;
  }
  const rounded = Math.floor(value);
  return Math.min(Math.max(rounded, 1_000), MAX_POLL_TIMEOUT_MS);
}

function parseFetchMessagesArgs(args: unknown): FetchMessagesArgs {
  const record = asObject(args);
  const waitForNew =
    typeof record.wait_for_new === "boolean" ? record.wait_for_new : false;
  const fallbackTimeout = waitForNew ? 15_000 : DEFAULT_POLL_TIMEOUT_MS;

  return {
    waitForNew,
    timeoutMs: clampTimeoutMs(record.timeout_ms, fallbackTimeout),
  };
}

function parseResetSyncArgs(args: unknown): ResetSyncArgs {
  const record = asObject(args);
  return {
    clearContextCache:
      typeof record.clear_context_cache === "boolean"
        ? record.clear_context_cache
        : false,
  };
}

function parseReplyArgs(
  args: unknown,
): { value: ReplyArgs } | { error: string } {
  const record = asObject(args);
  const senderId = record.sender_id;
  const text = record.text;

  if (typeof senderId !== "string" || !senderId.trim()) {
    return { error: "sender_id must be a non-empty string." };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { error: "text must be a non-empty string." };
  }

  return {
    value: {
      senderId: senderId.trim(),
      text: text.trim(),
    },
  };
}

function parseNotifyArgs(
  args: unknown,
): { value: NotifyArgs } | { error: string } {
  const record = asObject(args);
  const message = record.message;
  const recipientId = record.recipient_id;

  if (typeof message !== "string" || !message.trim()) {
    return { error: "message must be a non-empty string." };
  }
  if (recipientId !== undefined && typeof recipientId !== "string") {
    return { error: "recipient_id must be a string when provided." };
  }

  return {
    value: {
      message: message.trim(),
      recipientId: typeof recipientId === "string" ? recipientId.trim() : undefined,
    },
  };
}

function parseSendImageArgs(
  args: unknown,
): { value: SendImageArgs } | { error: string } {
  const record = asObject(args);
  const imagePath = record.image_path;
  const caption = record.caption;
  const recipientId = record.recipient_id;

  if (typeof imagePath !== "string" || !imagePath.trim()) {
    return { error: "image_path must be a non-empty string." };
  }
  if (caption !== undefined && typeof caption !== "string") {
    return { error: "caption must be a string when provided." };
  }
  if (recipientId !== undefined && typeof recipientId !== "string") {
    return { error: "recipient_id must be a string when provided." };
  }

  return {
    value: {
      imagePath: imagePath.trim(),
      caption: typeof caption === "string" ? caption.trim() : undefined,
      recipientId: typeof recipientId === "string" ? recipientId.trim() : undefined,
    },
  };
}

function parseSendFileArgs(
  args: unknown,
): { value: SendFileArgs } | { error: string } {
  const record = asObject(args);
  const filePath = record.file_path;
  const title = record.title;
  const recipientId = record.recipient_id;

  if (typeof filePath !== "string" || !filePath.trim()) {
    return { error: "file_path must be a non-empty string." };
  }
  if (title !== undefined && typeof title !== "string") {
    return { error: "title must be a string when provided." };
  }
  if (recipientId !== undefined && typeof recipientId !== "string") {
    return { error: "recipient_id must be a string when provided." };
  }

  return {
    value: {
      filePath: filePath.trim(),
      title: typeof title === "string" ? title.trim() : undefined,
      recipientId: typeof recipientId === "string" ? recipientId.trim() : undefined,
    },
  };
}

function parseSendVoiceArgs(
  args: unknown,
): { value: SendVoiceArgs } | { error: string } {
  const record = asObject(args);
  const voicePath = record.voice_path;
  const recipientId = record.recipient_id;

  if (typeof voicePath !== "string" || !voicePath.trim()) {
    return { error: "voice_path must be a non-empty string." };
  }
  if (recipientId !== undefined && typeof recipientId !== "string") {
    return { error: "recipient_id must be a string when provided." };
  }

  return {
    value: {
      voicePath: voicePath.trim(),
      recipientId: typeof recipientId === "string" ? recipientId.trim() : undefined,
    },
  };
}

function parseSendVideoArgs(
  args: unknown,
): { value: SendVideoArgs } | { error: string } {
  const record = asObject(args);
  const videoPath = record.video_path;
  const title = record.title;
  const recipientId = record.recipient_id;

  if (typeof videoPath !== "string" || !videoPath.trim()) {
    return { error: "video_path must be a non-empty string." };
  }
  if (title !== undefined && typeof title !== "string") {
    return { error: "title must be a string when provided." };
  }
  if (recipientId !== undefined && typeof recipientId !== "string") {
    return { error: "recipient_id must be a string when provided." };
  }

  return {
    value: {
      videoPath: videoPath.trim(),
      title: typeof title === "string" ? title.trim() : undefined,
      recipientId: typeof recipientId === "string" ? recipientId.trim() : undefined,
    },
  };
}

async function fetchMessages(args: FetchMessagesArgs): Promise<string> {
  const result = await transport.pollMessages({
    timeoutMs: args.timeoutMs,
  });

  if (!result.messages.length) {
    return "No new WeChat messages.";
  }

  return formatFetchedMessages(result.messages);
}

function formatFetchedMessages(messages: InboundWechatMessage[]): string {
  const blocks = messages.map((message, index) => {
    const lines = [
      `[${index + 1}]`,
      `sender_id: ${message.senderId}`,
      `sender: ${message.sender}`,
      `session_id: ${message.sessionId || "(unknown)"}`,
      `created_at: ${message.createdAt}`,
      "text:",
      message.text,
    ];
    if (message.attachments.length > 0) {
      lines.push(
        "attachments:",
        ...message.attachments.map((attachment) =>
          [
            `- kind: ${attachment.kind}`,
            `  name: ${attachment.fileName}`,
            `  size: ${formatByteSize(attachment.sizeBytes)}`,
            `  path: ${attachment.path}`,
          ].join("\n"),
        ),
      );
    }
    return lines.join("\n");
  });

  return [
    `Fetched ${messages.length} new WeChat message${messages.length === 1 ? "" : "s"}.`,
    "",
    ...blocks,
  ].join("\n");
}

async function replyToMessage(args: ReplyArgs): Promise<string> {
  await transport.sendText(args.senderId, args.text);
  return `Sent reply to ${args.senderId}.`;
}

async function sendNotification(args: NotifyArgs): Promise<string> {
  const recipientId = await transport.sendNotification(args.message, args.recipientId);
  return `Sent message to ${recipientId}.`;
}

async function sendImage(args: SendImageArgs): Promise<string> {
  const recipientId = await transport.sendImage(args.imagePath, {
    recipientId: args.recipientId,
    caption: args.caption,
  });
  return `Sent image to ${recipientId}.`;
}

async function sendFile(args: SendFileArgs): Promise<string> {
  const recipientId = await transport.sendFile(args.filePath, {
    recipientId: args.recipientId,
    title: args.title,
  });
  return `Sent file to ${recipientId}.`;
}

async function sendVoice(args: SendVoiceArgs): Promise<string> {
  const recipientId = await transport.sendVoice(args.voicePath, args.recipientId);
  return `Sent voice to ${recipientId}.`;
}

async function sendVideo(args: SendVideoArgs): Promise<string> {
  const recipientId = await transport.sendVideo(args.videoPath, {
    recipientId: args.recipientId,
    title: args.title,
  });
  return `Sent video to ${recipientId}.`;
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

async function executeTextAction(
  action: () => Promise<string> | string,
): Promise<{ content: { type: "text"; text: string }[] }> {
  try {
    return textResult(await action());
  } catch (err) {
    return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const mcp = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: {
      tools: {},
    },
    instructions: [
      "Use wechat_fetch_messages to pull new inbound WeChat messages.",
      "Use wechat_reply to send a plain-text reply to a sender_id.",
      "Use wechat_notify for proactive outbound text notifications.",
      "Use wechat_send_image, wechat_send_file, wechat_send_voice, and wechat_send_video for outbound media.",
      "If recipient_id is omitted for outbound tools, the most recently active cached recipient is used.",
      "Use wechat_get_status to inspect auth and local state.",
      "Use wechat_reset_sync if you need to clear local sync state.",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_get_status",
      description: "Show saved account information and local MCP state files.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "wechat_fetch_messages",
      description: "Pull new WeChat messages using the saved sync cursor.",
      inputSchema: {
        type: "object" as const,
        properties: {
          wait_for_new: {
            type: "boolean",
            description: "If true, long-poll briefly for new messages before returning.",
          },
          timeout_ms: {
            type: "number",
            description: "Polling timeout in milliseconds. Max 35000.",
          },
        },
      },
    },
    {
      name: "wechat_reply",
      description: "Send a plain-text reply to a WeChat sender_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "The sender_id from wechat_fetch_messages output.",
          },
          text: {
            type: "string",
            description: "The plain-text message to send.",
          },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_notify",
      description:
        "Send a proactive plain-text message. If recipient_id is omitted, sends to the most recently active cached recipient.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The plain-text message to send.",
          },
          recipient_id: {
            type: "string",
            description:
              "Optional WeChat user ID (xxx@im.wechat). Defaults to the most recently active cached recipient.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "wechat_send_image",
      description:
        "Send an image file. The image is encrypted, uploaded to WeChat CDN, and sent as an image message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          image_path: {
            type: "string",
            description: "Absolute path to the image file on disk.",
          },
          caption: {
            type: "string",
            description: "Optional plain-text caption sent before the image.",
          },
          recipient_id: {
            type: "string",
            description:
              "Optional WeChat user ID (xxx@im.wechat). Defaults to the most recently active cached recipient.",
          },
        },
        required: ["image_path"],
      },
    },
    {
      name: "wechat_send_file",
      description:
        "Send any file. The file is encrypted, uploaded to WeChat CDN, and sent as a WeChat file message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file on disk.",
          },
          title: {
            type: "string",
            description: "Optional display name for the file. Defaults to the filename.",
          },
          recipient_id: {
            type: "string",
            description:
              "Optional WeChat user ID (xxx@im.wechat). Defaults to the most recently active cached recipient.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "wechat_send_voice",
      description:
        "Send a voice or audio file. The file is encrypted, uploaded to WeChat CDN, and sent as a voice message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          voice_path: {
            type: "string",
            description: "Absolute path to the audio file on disk.",
          },
          recipient_id: {
            type: "string",
            description:
              "Optional WeChat user ID (xxx@im.wechat). Defaults to the most recently active cached recipient.",
          },
        },
        required: ["voice_path"],
      },
    },
    {
      name: "wechat_send_video",
      description:
        "Send a video file. The file is encrypted, uploaded to WeChat CDN, and sent as a video message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          video_path: {
            type: "string",
            description: "Absolute path to the video file on disk.",
          },
          title: {
            type: "string",
            description: "Optional plain-text caption sent before the video.",
          },
          recipient_id: {
            type: "string",
            description:
              "Optional WeChat user ID (xxx@im.wechat). Defaults to the most recently active cached recipient.",
          },
        },
        required: ["video_path"],
      },
    },
    {
      name: "wechat_reset_sync",
      description: "Clear saved sync state so future fetches restart from a fresh cursor.",
      inputSchema: {
        type: "object" as const,
        properties: {
          clear_context_cache: {
            type: "boolean",
            description: "If true, also clear cached reply context tokens.",
          },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case "wechat_get_status":
      return textResult(transport.getStatusText());
    case "wechat_fetch_messages":
      return executeTextAction(() => fetchMessages(parseFetchMessagesArgs(req.params.arguments)));
    case "wechat_reset_sync":
      return textResult(transport.resetSyncState(parseResetSyncArgs(req.params.arguments)));
    case "wechat_reply": {
      const parsed = parseReplyArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return executeTextAction(() => replyToMessage(parsed.value));
    }
    case "wechat_notify": {
      const parsed = parseNotifyArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return executeTextAction(() => sendNotification(parsed.value));
    }
    case "wechat_send_image": {
      const parsed = parseSendImageArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return executeTextAction(() => sendImage(parsed.value));
    }
    case "wechat_send_file": {
      const parsed = parseSendFileArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return executeTextAction(() => sendFile(parsed.value));
    }
    case "wechat_send_voice": {
      const parsed = parseSendVoiceArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return executeTextAction(() => sendVoice(parsed.value));
    }
    case "wechat_send_video": {
      const parsed = parseSendVideoArgs(req.params.arguments);
      if ("error" in parsed) {
        return textResult(`error: ${parsed.error}`);
      }
      return executeTextAction(() => sendVideo(parsed.value));
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

async function main() {
  if (process.argv.includes("--check")) {
    log(transport.getStatusText());
    process.exit(0);
  }

  await mcp.connect(new StdioServerTransport());
  log("WeChat MCP server is ready.");
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
