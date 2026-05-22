#!/usr/bin/env bun
/**
 * Standalone WeChat + Claude bot.
 *
 * This script directly connects WeChat ClawBot to Claude API,
 * bypassing the MCP channel protocol.
 *
 * Usage:
 *   bun run src/wechat/standalone-bot.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import {
  CHANNEL_DATA_DIR,
  CREDENTIALS_FILE,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";

// Types
type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

interface TextItem {
  text?: string;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: { text?: string };
  ref_msg?: RefMessage;
}

interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// Constants
const LOG_DIR = path.join(CHANNEL_DATA_DIR, "logs");
const BOT_TYPE = "3";
const CHANNEL_VERSION = "0.1.0";
const LONG_POLL_TIMEOUT_MS = 35_000;
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_VOICE = 3;
const MSG_STATE_FINISH = 2;

// Conversation history per user
const conversationHistory = new Map<string, Array<{role: string, content: string}>>();
const MAX_HISTORY = 10;

// Logging
function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logError(message: string): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

// Load WeChat credentials
function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      logError(`Credentials file not found: ${CREDENTIALS_FILE}`);
      return null;
    }
    const content = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(content) as AccountData;
  } catch (err) {
    logError(`Failed to read credentials: ${String(err)}`);
    return null;
  }
}

// WeChat API utilities
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };

  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(params.token, params.body),
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function extractTextFromMessage(msg: WeixinMessage): string {
  if (!msg.item_list?.length) {
    return "";
  }

  const lines: string[] = [];

  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT) {
      const text = item.text_item?.text?.trim();
      if (text) {
        lines.push(text);
      }
    }

    if (item.type === MSG_ITEM_VOICE) {
      const transcript = item.voice_item?.text?.trim();
      if (transcript) {
        lines.push(transcript);
      }
    }
  }

  return lines.join("\n").trim();
}

function generateClientId(): string {
  return `claude-wechat-bot:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error("Reply text cannot be empty.");
  }

  const clientId = generateClientId();
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: trimmedText } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  return clientId;
}

// Message deduplication
const recentMessageKeys = new Set<string>();
const recentMessageOrder: string[] = [];
const RECENT_MESSAGE_CACHE_SIZE = 500;

function buildMessageKey(msg: WeixinMessage): string {
  return [
    msg.from_user_id ?? "",
    msg.client_id ?? "",
    String(msg.create_time_ms ?? ""),
    msg.context_token ?? "",
  ].join("|");
}

function rememberMessage(key: string): boolean {
  if (!key || recentMessageKeys.has(key)) {
    return false;
  }

  recentMessageKeys.add(key);
  recentMessageOrder.push(key);

  while (recentMessageOrder.length > RECENT_MESSAGE_CACHE_SIZE) {
    const oldest = recentMessageOrder.shift();
    if (oldest) {
      recentMessageKeys.delete(oldest);
    }
  }

  return true;
}

// Claude API integration
let anthropic: Anthropic | null = null;

function initClaude(): boolean {
  // 使用与 Claude Code 相同的代理配置
  const baseURL = process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15721";

  anthropic = new Anthropic({
    apiKey: "dummy-key", // 代理不需要真实的 API key
    baseURL: baseURL,
    dangerouslyAllowBrowser: true, // 允许在非标准环境下使用
  });

  log(`Claude API initialized (via proxy: ${baseURL})`);
  return true;
}

async function getClaudeResponse(
  userMessage: string,
  userId: string,
): Promise<string> {
  if (!anthropic) {
    throw new Error("Claude API not initialized");
  }

  // Get or create conversation history
  let history = conversationHistory.get(userId) || [];

  // Add user message to history
  history.push({ role: "user", content: userMessage });

  // Keep only recent messages
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: "你是一个有帮助的AI助手。请用简洁、友好的方式回复，适合微信聊天场景。",
      messages: history as any,
    });

    // Extract the response text
    let responseText = "";
    for (const block of msg.content) {
      if (block.type === "text") {
        responseText += block.text;
      }
    }

    // Add assistant response to history
    history.push({ role: "assistant", content: responseText });
    conversationHistory.set(userId, history);

    return responseText;
  } catch (err) {
    logError(`Claude API error: ${String(err)}`);
    throw err;
  }
}

// Main polling loop
async function startPolling(account: AccountData): Promise<never> {
  const { baseUrl, token } = account;
  let getUpdatesBuf = "";

  // Load sync state
  try {
    if (fs.existsSync(SYNC_BUF_FILE)) {
      getUpdatesBuf = fs.readFileSync(SYNC_BUF_FILE, "utf-8");
      if (getUpdatesBuf) {
        log(`Recovered sync state from ${SYNC_BUF_FILE}`);
      }
    }
  } catch (err) {
    logError(`Failed to load sync state: ${String(err)}`);
  }

  log("Starting WeChat message polling loop...");
  log("Press Ctrl+C to stop");

  const contextTokenCache = new Map<string, string>();

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        logError(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      // Save sync state
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        try {
          fs.writeFileSync(SYNC_BUF_FILE, getUpdatesBuf, "utf-8");
        } catch (err) {
          logError(`Failed to persist sync state: ${String(err)}`);
        }
      }

      // Process messages
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) {
          continue;
        }

        const text = extractTextFromMessage(msg);
        if (!text) {
          continue;
        }

        const senderId = msg.from_user_id ?? "unknown";
        const messageKey = buildMessageKey(msg);

        if (!rememberMessage(messageKey)) {
          continue;
        }

        // Cache context token for replies
        if (msg.context_token) {
          contextTokenCache.set(senderId, msg.context_token);
        }

        log(`📨 收到消息 from ${senderId}: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);

        // Get response from Claude
        try {
          const response = await getClaudeResponse(text, senderId);
          log(`📤 发送回复 to ${senderId}: ${response.slice(0, 50)}${response.length > 50 ? "..." : ""}`);

          const contextToken = contextTokenCache.get(senderId) || "";
          await sendTextMessage(baseUrl, token, senderId, response, contextToken);
        } catch (err) {
          logError(`Failed to get/send response: ${String(err)}`);
          // Send error message to user
          try {
            const contextToken = contextTokenCache.get(senderId) || "";
            await sendTextMessage(
              baseUrl,
              token,
              senderId,
              "抱歉，我遇到了一些问题，请稍后再试。",
              contextToken,
            );
          } catch {
            // Ignore
          }
        }
      }
    } catch (err) {
      logError(`Polling error: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// Main function
async function main() {
  log("=== WeChat + Claude 独立机器人 ===");
  log("");
  migrateLegacyChannelFiles(log);

  // Load WeChat credentials
  log(`正在加载微信凭据: ${CREDENTIALS_FILE}`);
  const account = loadCredentials();
  if (!account) {
  logError("无法加载微信凭据，请先运行: bun run setup");
    process.exit(1);
  }
  log(`✓ 微信账号: ${account.accountId}`);

  // Initialize Claude API
  log("");
  log("正在初始化 Claude API...");
  if (!initClaude()) {
    logError("Claude API 初始化失败");
    process.exit(1);
  }

  log("");
  log("✓ 所有初始化完成！");
  log("");

  // Start polling
  await startPolling(account);
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
