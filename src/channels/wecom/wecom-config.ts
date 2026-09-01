import fs from "node:fs";
import path from "node:path";

import {
  CHANNEL_DATA_DIR,
  ensureChannelDataDir,
} from "../../wechat/channel-config.ts";

export type StoredWecomAccount = {
  version: 1;
  botId: string;
  secret: string;
  operatorUserId: string;
  pairedAt: string;
};

export const WECOM_DATA_DIR = path.join(CHANNEL_DATA_DIR, "wecom");
export const WECOM_CREDENTIALS_FILE = path.join(WECOM_DATA_DIR, "account.json");
export const WECOM_INBOUND_ATTACHMENTS_DIR = path.join(
  WECOM_DATA_DIR,
  "inbound-attachments",
);
export const WECOM_INBOUND_MESSAGE_CLAIMS_DIR = path.join(
  WECOM_DATA_DIR,
  "inbound-message-claims",
);

export function ensureWecomDataDir(): void {
  ensureChannelDataDir();
  fs.mkdirSync(WECOM_DATA_DIR, { recursive: true });
}

export function loadStoredWecomAccount(
  filePath = WECOM_CREDENTIALS_FILE,
): StoredWecomAccount | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<StoredWecomAccount>;
    if (
      parsed.version !== 1 ||
      typeof parsed.botId !== "string" ||
      !parsed.botId.trim() ||
      typeof parsed.secret !== "string" ||
      !parsed.secret.trim() ||
      typeof parsed.operatorUserId !== "string" ||
      !parsed.operatorUserId.trim() ||
      typeof parsed.pairedAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      botId: parsed.botId.trim(),
      secret: parsed.secret.trim(),
      operatorUserId: parsed.operatorUserId.trim(),
      pairedAt: parsed.pairedAt,
    };
  } catch {
    return null;
  }
}

export function resolveWecomAccount(
  env: NodeJS.ProcessEnv = process.env,
  stored = loadStoredWecomAccount(),
): StoredWecomAccount | null {
  const botId = env.WECOM_BOT_ID?.trim() || stored?.botId || "";
  const secret = env.WECOM_BOT_SECRET?.trim() || stored?.secret || "";
  const operatorUserId =
    env.WECOM_OPERATOR_USER_ID?.trim() || stored?.operatorUserId || "";
  if (!botId || !secret || !operatorUserId) {
    return null;
  }
  return {
    version: 1,
    botId,
    secret,
    operatorUserId,
    pairedAt: stored?.pairedAt || new Date().toISOString(),
  };
}

export function saveWecomAccount(
  account: StoredWecomAccount,
  filePath = WECOM_CREDENTIALS_FILE,
): void {
  if (filePath === WECOM_CREDENTIALS_FILE) {
    ensureWecomDataDir();
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(account, null, 2), "utf-8");
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on Windows.
  }
  fs.renameSync(tempPath, filePath);
}
