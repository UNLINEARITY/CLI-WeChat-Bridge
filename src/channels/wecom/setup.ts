#!/usr/bin/env bun

import crypto from "node:crypto";
import readline from "node:readline";
import { Writable } from "node:stream";

import {
  WSClient,
  type BaseMessage,
  type WsFrame,
} from "@wecom/aibot-node-sdk";

import {
  loadStoredWecomAccount,
  resolveWecomAccount,
  saveWecomAccount,
  type StoredWecomAccount,
} from "./wecom-config.ts";
import type { WecomSdkClient } from "./wecom-transport.ts";

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

export function createWecomPairingCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function isWecomPairingMessage(
  frame: WsFrame<BaseMessage>,
  code: string,
): boolean {
  const body = frame.body;
  return Boolean(
    body &&
      body.chattype === "single" &&
      body.from?.userid &&
      body.msgtype === "text" &&
      body.text?.content?.trim() === `/pair ${code}`,
  );
}

function createSetupClient(botId: string, secret: string): WecomSdkClient {
  return new WSClient({
    botId,
    secret,
    maxReconnectAttempts: 3,
    maxAuthFailureAttempts: 2,
    heartbeatInterval: 30_000,
  });
}

export async function pairWecomOperator(options: {
  botId: string;
  secret: string;
  code?: string;
  timeoutMs?: number;
  clientFactory?: (botId: string, secret: string) => WecomSdkClient;
  log?: SetupLogger;
}): Promise<StoredWecomAccount> {
  const log = options.log ?? console.log;
  const code = options.code ?? createWecomPairingCode();
  const client = (options.clientFactory ?? createSetupClient)(options.botId, options.secret);

  return new Promise<StoredWecomAccount>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, operatorUserId?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.disconnect();
      if (error) {
        reject(error);
        return;
      }
      resolve({
        version: 1,
        botId: options.botId,
        secret: options.secret,
        operatorUserId: operatorUserId!,
        pairedAt: new Date().toISOString(),
      });
    };

    const timer = setTimeout(() => {
      finish(new Error("WeCom operator pairing timed out."));
    }, options.timeoutMs ?? PAIRING_TIMEOUT_MS);
    timer.unref?.();

    client.on("authenticated", () => {
      log("WeCom authentication succeeded.");
      log(`Send /pair ${code} to the bot in a direct chat within 10 minutes.`);
    });
    client.on("message", (frame: WsFrame<BaseMessage>) => {
      if (isWecomPairingMessage(frame, code)) {
        finish(undefined, frame.body!.from.userid);
      }
    });
    client.on("event.disconnected_event", () => {
      finish(new Error("Another process connected the same WeCom bot during pairing."));
    });
    client.on("error", (error: Error) => {
      finish(error);
    });
    client.connect();
  });
}

async function validateWecomAccount(
  account: StoredWecomAccount,
  options: {
    clientFactory?: (botId: string, secret: string) => WecomSdkClient;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const client = (options.clientFactory ?? createSetupClient)(account.botId, account.secret);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.disconnect();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new Error("WeCom credential validation timed out.")),
      options.timeoutMs ?? 15_000,
    );
    client.on("authenticated", () => finish());
    client.on("error", (error: Error) => finish(error));
    client.on("event.disconnected_event", () =>
      finish(new Error("Another process is already using this WeCom bot.")),
    );
    client.connect();
  });
}

export async function ensureWecomAccount(options: {
  log?: SetupLogger;
  setup?: () => Promise<StoredWecomAccount>;
} = {}): Promise<StoredWecomAccount> {
  const existing = resolveWecomAccount();
  if (existing) {
    return existing;
  }
  options.log?.("No paired WeCom account found. Starting setup...");
  return (options.setup ?? (() => runWecomSetup([])))();
}

export async function runWecomSetup(
  argv: string[] = process.argv.slice(2),
): Promise<StoredWecomAccount> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: wecom-setup [--check]");
    console.log("");
    console.log("Pairs one WeCom operator with the local CLI bridge.");
    console.log("Bot credentials may also be supplied through WECOM_BOT_ID and WECOM_BOT_SECRET.");
    process.exit(0);
  }

  const resolved = resolveWecomAccount();
  if (argv.includes("--check")) {
    if (!resolved) {
      throw new Error("No complete WeCom credentials are configured.");
    }
    await validateWecomAccount(resolved);
    console.log(`WeCom credentials are valid. Paired operator: ${resolved.operatorUserId}`);
    return resolved;
  }

  const stored = loadStoredWecomAccount();
  const botId = process.env.WECOM_BOT_ID?.trim() ||
    await ask(`Bot ID${stored?.botId ? ` [${stored.botId}]` : ""}: `) || stored?.botId || "";
  const secret = process.env.WECOM_BOT_SECRET?.trim() ||
    await askSecret(`Bot Secret${stored?.secret ? " [press Enter to keep saved value]" : ""}: `) ||
    stored?.secret || "";
  if (!botId || !secret) {
    throw new Error("Bot ID and Bot Secret are required.");
  }

  const account = await pairWecomOperator({ botId, secret });
  saveWecomAccount(account);
  console.log("WeCom operator pairing completed.");
  console.log("Start from a project directory with wecom-codex, wecom-claude, wecom-opencode, wecom-pi, or wecom-daemon.");
  return account;
}
