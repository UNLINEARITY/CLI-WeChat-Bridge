#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import crypto from "node:crypto";
import readline from "node:readline";
import { Writable } from "node:stream";

import {
  loadStoredTelegramAccount,
  resolveTelegramAccount,
  saveTelegramAccount,
  type StoredTelegramAccount,
} from "./telegram-config.ts";
import { TelegramTransport } from "./telegram-transport.ts";

const PAIRING_TIMEOUT_MS = 10 * 60 * 1000;

type SetupLogger = (message: string) => void;

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return ask(prompt);
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk);
      }
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

export function createTelegramPairingCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function isTelegramPairingText(text: string, code: string): boolean {
  return text.trim() === `/pair ${code}`;
}

/**
 * Pair the operator: validate the token, then run a temporary long poll and
 * wait for the operator to send `/pair <code>` from their Telegram account.
 * Records the user id (authorization gate) and the chat id (send target).
 */
export async function pairTelegramOperator(options: {
  botToken: string;
  code?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: SetupLogger;
}): Promise<StoredTelegramAccount> {
  const log = options.log ?? console.log;
  const code = options.code ?? createTelegramPairingCode();

  const transport = new TelegramTransport({
    account: {
      version: 1,
      botToken: options.botToken,
      botUsername: "",
      operatorUserId: "",
      operatorChatId: "",
      pairedAt: new Date().toISOString(),
    },
    fetchImpl: options.fetchImpl,
  });

  const botUsername = await transport.validateToken();
  log(`Telegram bot @${botUsername} authenticated.`);

  try {
    return await new Promise<StoredTelegramAccount>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, account?: StoredTelegramAccount) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error || !account) {
          reject(error ?? new Error("Telegram operator pairing failed."));
          return;
        }
        resolve(account);
      };
      const timer = setTimeout(() => {
        finish(new Error("Telegram operator pairing timed out."));
      }, options.timeoutMs ?? PAIRING_TIMEOUT_MS);
      timer.unref?.();

      transport.setHandlers({
        onMessage: async () => {},
        onConnected: async () => {
          log(`Send /pair ${code} to @${botUsername} from your Telegram account within 10 minutes.`);
        },
        onFatal: async (error) => {
          finish(error);
        },
        onPreAuthMessage: async (message) => {
          if (message.chatType !== "private" || !isTelegramPairingText(message.text, code)) {
            return;
          }
          finish(undefined, {
            version: 1,
            botToken: options.botToken,
            botUsername,
            operatorUserId: message.userId,
            operatorChatId: message.chatId,
            pairedAt: new Date().toISOString(),
          });
        },
      });
      void transport.start();
    });
  } finally {
    await transport.stop();
  }
}

export async function ensureTelegramAccount(options: {
  log?: SetupLogger;
  setup?: () => Promise<StoredTelegramAccount>;
} = {}): Promise<StoredTelegramAccount> {
  const existing = resolveTelegramAccount();
  if (existing) {
    return existing;
  }
  options.log?.("No paired Telegram account found. Starting setup...");
  return (options.setup ?? (() => runTelegramSetup([])))();
}

export async function runTelegramSetup(
  argv: string[] = process.argv.slice(2),
): Promise<StoredTelegramAccount> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: telegram-setup [--check]");
    console.log("");
    console.log("Pairs one Telegram operator with the local CLI bridge.");
    console.log("The bot token may also be supplied through TELEGRAM_BOT_TOKEN.");
    process.exit(0);
  }

  const resolved = resolveTelegramAccount();
  if (argv.includes("--check")) {
    if (!resolved) {
      throw new Error("No complete Telegram credentials are configured.");
    }
    const transport = new TelegramTransport({ account: resolved });
    const username = await transport.validateToken();
    console.log(
      `Telegram credentials are valid. Bot: @${username}, paired operator: ${resolved.operatorUserId}`,
    );
    return resolved;
  }

  const stored = loadStoredTelegramAccount();
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    await askSecret(
      `Bot Token${stored?.botToken ? " [press Enter to keep saved value]" : " (from @BotFather)"}: `,
    ) ||
    stored?.botToken || "";
  if (!botToken) {
    throw new Error("A Telegram bot token is required.");
  }

  const account = await pairTelegramOperator({ botToken });
  saveTelegramAccount(account);
  console.log("Telegram operator pairing completed.");
  console.log(
    "Start from a project directory with telegram-codex, telegram-claude, telegram-opencode, telegram-pi, or telegram-daemon.",
  );
  return account;
}
