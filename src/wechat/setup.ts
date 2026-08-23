#!/usr/bin/env bun
/**
 * CLI WeChat Bridge setup.
 *
 * Installed bridge commands run this automatically on first use.
 * To force a relogin manually:
 *   wechat-setup
 */

import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

import {
  BOT_TYPE,
  CONTEXT_CACHE_FILE,
  CREDENTIALS_FILE,
  DEFAULT_BASE_URL,
  ensureChannelDataDir,
  migrateLegacyChannelFiles,
  SYNC_BUF_FILE,
} from "./channel-config.ts";
import { isWechatSyncSessionTimeout } from "./wechat-transport.ts";

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export type StoredAccount = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

type WechatLoginOptions = {
  baseUrl?: string;
  requireUserId?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  write?: (message: string) => void;
};

type EnsureWechatCredentialsOptions = WechatLoginOptions & {
  login?: () => Promise<StoredAccount>;
  validateExisting?: boolean;
  validationTimeoutMs?: number;
};

const CHANNEL_VERSION = "0.3.0";

export function loadExistingCredentials(): StoredAccount | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8")) as StoredAccount;
  } catch {
    return null;
  }
}

export function getWechatLoginRequiredReason(
  account: StoredAccount | null,
  options: {
    requireUserId?: boolean;
  } = {},
): string | null {
  if (!account) {
    return "No saved WeChat credentials found.";
  }
  if (options.requireUserId && !account.userId) {
    return "Saved WeChat credentials are missing userId.";
  }
  return null;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

export async function getStoredCredentialsInvalidReason(
  account: StoredAccount,
  options: {
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const baseUrl = account.baseUrl || DEFAULT_BASE_URL;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/getupdates`;
  const body = JSON.stringify({
    get_updates_buf: "",
    base_info: { channel_version: CHANNEL_VERSION },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body, "utf-8")),
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${account.token}`,
        "X-WECHAT-UIN": randomWechatUin(),
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return "Saved WeChat credentials were rejected by the server.";
    }
    if (!res.ok) {
      return null;
    }

    const response = JSON.parse(text) as {
      errcode?: number;
      errmsg?: string;
    };
    if (isWechatSyncSessionTimeout(response)) {
      return "Saved WeChat login has expired.";
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return null;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }

  return null;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`QR fetch failed: ${res.status}`);
  }
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);

  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`QR status failed: ${res.status}`);
    }
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function askYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function printQRCode(
  qrContent: string,
  write: (message: string) => void,
): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrContent, { small: true }, (qr: string) => {
        write(`${qr}\n`);
        resolve();
      });
    });
  } catch {
    write(`Open this QR code URL in a browser: ${qrContent}\n\n`);
  }
}

function saveCredentials(account: StoredAccount): void {
  ensureChannelDataDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(account, null, 2), "utf-8");
  for (const staleStateFile of [SYNC_BUF_FILE, CONTEXT_CACHE_FILE]) {
    try {
      fs.rmSync(staleStateFile, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // Best effort on Windows.
  }
}

function printPostLoginHelp(log: (message: string) => void): void {
  log("This WeChat account is now authorized for the bridge.");
  log("");
  log("Start from any project directory with one of:");
  log("  wechat-codex");
  log("  wechat-claude");
  log("  wechat-opencode");
  log("  wechat-pi");
  log("  wechat-daemon");
  log("");
  log("Run wechat-setup again any time you need to refresh the login.");
}

export async function runWechatLogin(
  options: WechatLoginOptions = {},
): Promise<StoredAccount> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const log = options.log ?? ((message: string) => console.log(message));
  const write = options.write ?? ((message: string) => process.stdout.write(message));
  const timeoutMs = options.timeoutMs ?? 480_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  log("Fetching WeChat login QR code...\n");
  const qrResp = await fetchQRCode(baseUrl);
  await printQRCode(qrResp.qrcode_img_content, write);

  log("Scan the QR code above with WeChat, then confirm the login on your phone.\n");

  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          log("\nQR code scanned. Confirm the login in WeChat...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        throw new Error("The QR code expired. Run setup again.");
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("Login failed: missing bot credentials from server.");
        }
        if (options.requireUserId && !status.ilink_user_id) {
          throw new Error("Login failed: missing WeChat userId from server.");
        }

        const account: StoredAccount = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };

        saveCredentials(account);

        log("\nWeChat login completed.");
        log(`Account ID: ${account.accountId}`);
        log(`User ID: ${account.userId ?? "(unknown)"}`);
        log(`Credentials saved to: ${CREDENTIALS_FILE}`);
        log("");
        return account;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Login timed out. Run setup again.");
}

export async function ensureWechatCredentials(
  options: EnsureWechatCredentialsOptions = {},
): Promise<StoredAccount> {
  const log = options.log ?? ((message: string) => console.log(message));
  migrateLegacyChannelFiles(log);

  const existing = loadExistingCredentials();
  const loginReason = getWechatLoginRequiredReason(existing, {
    requireUserId: options.requireUserId,
  });
  if (!loginReason) {
    const account = existing as StoredAccount;
    if (options.validateExisting) {
      const invalidReason = await getStoredCredentialsInvalidReason(account, {
        timeoutMs: options.validationTimeoutMs,
      });
      if (invalidReason) {
        log(`${invalidReason} Starting WeChat login...`);
        const login = options.login ?? (() => runWechatLogin(options));
        return login();
      }
    }
    return account;
  }

  log(`${loginReason} Starting WeChat login...`);
  const login = options.login ?? (() => runWechatLogin(options));
  return login();
}

async function main() {
  migrateLegacyChannelFiles((message) => console.log(message));

  const existing = loadExistingCredentials();
  if (existing) {
    console.log(`Found saved account: ${existing.accountId}`);
    console.log(`Saved at: ${existing.savedAt}`);
    console.log(`Credentials file: ${CREDENTIALS_FILE}`);
    console.log();

    const shouldRelogin = await askYesNo("Log in again? (y/N) ");
    if (!shouldRelogin) {
      console.log("Keeping existing credentials.");
      return;
    }
  }

  await runWechatLogin({ requireUserId: true });
  printPostLoginHelp((message) => console.log(message));
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}
