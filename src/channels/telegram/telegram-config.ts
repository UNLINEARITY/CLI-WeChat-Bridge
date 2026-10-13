// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import path from "node:path";

import {
  CHANNEL_DATA_DIR,
  ensureChannelDataDir,
} from "../../wechat/channel-config.ts";

export type StoredTelegramAccount = {
  version: 1;
  botToken: string;
  botUsername: string;
  /** Telegram user id of the paired operator (authorization gate). */
  operatorUserId: string;
  /** Private chat id with the operator; Telegram send target. */
  operatorChatId: string;
  pairedAt: string;
};

export const TELEGRAM_DATA_DIR = path.join(CHANNEL_DATA_DIR, "telegram");
export const TELEGRAM_CREDENTIALS_FILE = path.join(TELEGRAM_DATA_DIR, "account.json");
export const TELEGRAM_INBOUND_ATTACHMENTS_DIR = path.join(
  TELEGRAM_DATA_DIR,
  "inbound-attachments",
);
export const TELEGRAM_INBOUND_MESSAGE_CLAIMS_DIR = path.join(
  TELEGRAM_DATA_DIR,
  "inbound-message-claims",
);

export function ensureTelegramDataDir(): void {
  ensureChannelDataDir();
  fs.mkdirSync(TELEGRAM_DATA_DIR, { recursive: true });
}

export function normalizeStoredTelegramAccount(
  parsed: Partial<StoredTelegramAccount>,
): StoredTelegramAccount | null {
  if (
    parsed.version !== 1 ||
    typeof parsed.botToken !== "string" ||
    !parsed.botToken.trim() ||
    typeof parsed.operatorUserId !== "string" ||
    !parsed.operatorUserId.trim() ||
    typeof parsed.operatorChatId !== "string" ||
    !parsed.operatorChatId.trim() ||
    typeof parsed.pairedAt !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    botToken: parsed.botToken.trim(),
    botUsername: typeof parsed.botUsername === "string" ? parsed.botUsername.trim() : "",
    operatorUserId: parsed.operatorUserId.trim(),
    operatorChatId: parsed.operatorChatId.trim(),
    pairedAt: parsed.pairedAt,
  };
}

export function loadStoredTelegramAccount(
  filePath = TELEGRAM_CREDENTIALS_FILE,
): StoredTelegramAccount | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    ) as Partial<StoredTelegramAccount>;
    return normalizeStoredTelegramAccount(parsed);
  } catch {
    return null;
  }
}

export function saveTelegramAccount(
  account: StoredTelegramAccount,
  filePath = TELEGRAM_CREDENTIALS_FILE,
): void {
  ensureTelegramDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(account, null, 2)}\n`, "utf-8");
}

export function resolveTelegramAccount(
  env: NodeJS.ProcessEnv = process.env,
  stored = loadStoredTelegramAccount(),
): StoredTelegramAccount | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || stored?.botToken || "";
  const operatorUserId =
    env.TELEGRAM_OPERATOR_USER_ID?.trim() || stored?.operatorUserId || "";
  const operatorChatId =
    env.TELEGRAM_OPERATOR_CHAT_ID?.trim() || stored?.operatorChatId || "";
  if (!botToken || !operatorUserId || !operatorChatId) {
    return null;
  }
  return {
    version: 1,
    botToken,
    botUsername: env.TELEGRAM_BOT_USERNAME?.trim() || stored?.botUsername || "",
    operatorUserId,
    operatorChatId,
    pairedAt: stored?.pairedAt ?? new Date().toISOString(),
  };
}
