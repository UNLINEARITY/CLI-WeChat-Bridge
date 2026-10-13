// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadStoredTelegramAccount,
  normalizeStoredTelegramAccount,
  resolveTelegramAccount,
  saveTelegramAccount,
  type StoredTelegramAccount,
} from "../../src/channels/telegram/telegram-config.ts";
import {
  buildTelegramInboundPrompt,
  toTelegramOutputKind,
} from "../../src/channels/telegram/telegram-message.ts";
import {
  TelegramPollConflictError,
  TelegramTokenRejectedError,
  TelegramTransport,
} from "../../src/channels/telegram/telegram-transport.ts";
import {
  createTelegramPairingCode,
  isTelegramPairingText,
  pairTelegramOperator,
} from "../../src/channels/telegram/setup.ts";
import { TelegramChannelDriver } from "../../src/channels/telegram/telegram-driver.ts";
import type { ChannelInboundMessage } from "../../src/core/channel-types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-channel-test-"));
  tempDirs.push(directory);
  return directory;
}

const account: StoredTelegramAccount = {
  version: 1,
  botToken: "test-token",
  botUsername: "test_bot",
  operatorUserId: "1001",
  operatorChatId: "1001",
  pairedAt: "2026-10-13T00:00:00.000Z",
};

type ApiCall = { method: string; body: Record<string, unknown> };

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function textUpdate(
  text: string,
  overrides: { fromId?: string; chatId?: string; messageId?: number } = {},
): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: overrides.messageId ?? 10,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: Number(overrides.chatId ?? 1001), type: "private" },
      from: { id: Number(overrides.fromId ?? 1001), is_bot: false },
    },
  };
}

describe("telegram config", () => {
  test("round-trips a stored account", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "account.json");
    saveTelegramAccount(account, file);
    expect(loadStoredTelegramAccount(file)).toEqual(account);
  });

  test("rejects incomplete accounts", () => {
    expect(normalizeStoredTelegramAccount({ version: 1 } as never)).toBeNull();
    expect(
      normalizeStoredTelegramAccount({ ...account, operatorChatId: " " }),
    ).toBeNull();
  });

  test("resolves from environment overrides", () => {
    const resolved = resolveTelegramAccount(
      {
        TELEGRAM_BOT_TOKEN: "env-token",
        TELEGRAM_OPERATOR_USER_ID: "42",
        TELEGRAM_OPERATOR_CHAT_ID: "42",
      },
      null,
    );
    expect(resolved?.botToken).toBe("env-token");
    expect(resolved?.operatorUserId).toBe("42");
  });
});

describe("telegram message helpers", () => {
  test("maps send contexts to output kinds", () => {
    expect(toTelegramOutputKind("final_reply")).toBe("final_reply");
    expect(toTelegramOutputKind("mirrored_user_input")).toBe("mirrored_input");
    expect(toTelegramOutputKind("unknown_kind" as never)).toBe("notice");
  });

  test("builds attachment prompts with local paths", () => {
    const prompt = buildTelegramInboundPrompt("look at this", [
      { kind: "image", path: "/tmp/a.png", fileName: "a.png", sizeBytes: 12 },
    ]);
    expect(prompt).toContain("look at this");
    expect(prompt).toContain("kind=image name=a.png bytes=12 path=/tmp/a.png");
  });
});

describe("telegram transport", () => {
  test("validateToken returns the bot username", async () => {
    const calls: ApiCall[] = [];
    const transport = new TelegramTransport({
      account,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          method: url.split("/").pop() ?? "",
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return jsonResponse({ ok: true, result: { username: "abc_bot" } });
      },
    });
    expect(await transport.validateToken()).toBe("abc_bot");
    expect(calls[0]?.method).toBe("getMe");
  });

  test("rejects invalid tokens with a typed error", async () => {
    const transport = new TelegramTransport({
      account,
      fetchImpl: async () =>
        jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }),
    });
    expect(transport.validateToken()).rejects.toBeInstanceOf(TelegramTokenRejectedError);
  });

  test("maps 409 conflicts to a typed error", async () => {
    const transport = new TelegramTransport({
      account,
      fetchImpl: async () =>
        jsonResponse({ ok: false, error_code: 409, description: "Conflict" }),
    });
    let caught: unknown;
    try {
      await transport.validateToken();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramPollConflictError);
  });

  test("sends text and chunks long messages", async () => {
    const calls: ApiCall[] = [];
    const transport = new TelegramTransport({
      account,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("getFile") || url.includes("/file/")) {
          throw new Error("unexpected media call");
        }
        calls.push({
          method: url.split("/").pop() ?? "",
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    const target = {
      channelId: "telegram",
      conversationId: "1001",
      recipientId: "1001",
    };
    await transport.sendText(target, "short", "notice");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.text).toBe("short");

    calls.length = 0;
    await transport.sendText(target, "x".repeat(8_000), "final_reply");
    expect(calls.length).toBe(3);
    expect(calls.every((call) => call.method === "sendMessage")).toBe(true);
    expect(calls[0]?.body.chat_id).toBe("1001");
  });

  test("delivers authorized inbound messages and dedups by claim", async () => {
    const dir = makeTempDir();
    const received: ChannelInboundMessage[] = [];
    let pollCount = 0;
    const transport = new TelegramTransport({
      account,
      claimsDir: path.join(dir, "claims"),
      attachmentsDir: path.join(dir, "attachments"),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes("getUpdates")) {
          pollCount += 1;
          const body = JSON.parse(String(init?.body ?? "{}"));
          const alreadyPolled = pollCount > 1;
          return jsonResponse(
            alreadyPolled
              ? { ok: true, result: [] }
              : { ok: true, result: [textUpdate("hello bridge")] },
          );
        }
        return jsonResponse({ ok: true, result: {} });
      },
    });
    transport.setHandlers({
      onMessage: async (message) => {
        received.push(message);
      },
      onConnected: async () => {
        // Signal the test loop by stopping after first delivery.
        await transport.stop();
      },
    });
    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("hello bridge");
    expect(received[0]?.senderId).toBe("1001");
    expect(received[0]?.conversation.conversationId).toBe("1001");
    expect(received[0]?.conversation.channelId).toBe("telegram");
  });

  test("routes unauthorized senders to the stock handler", async () => {
    const dir = makeTempDir();
    const unauthorized: Array<{ senderId: string; chatType: string }> = [];
    const transport = new TelegramTransport({
      account,
      claimsDir: path.join(dir, "claims"),
      attachmentsDir: path.join(dir, "attachments"),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("getUpdates")) {
          return jsonResponse({
            ok: true,
            result: [textUpdate("let me in", { fromId: "999", chatId: "999" })],
          });
        }
        return jsonResponse({ ok: true, result: {} });
      },
    });
    transport.setHandlers({
      onMessage: async () => {
        throw new Error("unauthorized message must not reach onMessage");
      },
      onUnauthorized: async (senderId, chatType) => {
        unauthorized.push({ senderId, chatType });
        await transport.stop();
      },
      onConnected: async () => {},
    });
    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(unauthorized).toEqual([{ senderId: "999", chatType: "private" }]);
  });

  test("fires the pre-auth hook for pairing before the gate", async () => {
    const dir = makeTempDir();
    const preAuth: string[] = [];
    const transport = new TelegramTransport({
      account: { ...account, operatorUserId: "", operatorChatId: "" },
      claimsDir: path.join(dir, "claims"),
      attachmentsDir: path.join(dir, "attachments"),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("getUpdates")) {
          return jsonResponse({
            ok: true,
            result: [textUpdate("/pair 123456", { fromId: "777", chatId: "777" })],
          });
        }
        return jsonResponse({ ok: true, result: {} });
      },
    });
    transport.setHandlers({
      onMessage: async () => {},
      onPreAuthMessage: async (message) => {
        preAuth.push(message.text);
        await transport.stop();
      },
      onConnected: async () => {},
    });
    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(preAuth).toEqual(["/pair 123456"]);
  });
});

describe("telegram setup", () => {
  test("pairing code helpers", () => {
    const code = createTelegramPairingCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(isTelegramPairingText(`/pair ${code}`, code)).toBe(true);
    expect(isTelegramPairingText(`code ${code}`, code)).toBe(false);
  });

  test("pairs the operator from a /pair message", async () => {
    let polled = false;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("getMe")) {
        return jsonResponse({ ok: true, result: { username: "pair_bot" } });
      }
      if (url.includes("getUpdates")) {
        if (polled) return jsonResponse({ ok: true, result: [] });
        polled = true;
        return jsonResponse({
          ok: true,
          result: [
            textUpdate("/pair 424242", { fromId: "555", chatId: "555", messageId: 7 }),
          ],
        });
      }
      return jsonResponse({ ok: true, result: {} });
    };

    const paired = await pairTelegramOperator({
      botToken: "pair-token",
      code: "424242",
      fetchImpl,
      log: () => {},
    });
    expect(paired.botUsername).toBe("pair_bot");
    expect(paired.operatorUserId).toBe("555");
    expect(paired.operatorChatId).toBe("555");
  });
});

describe("telegram driver", () => {
  test("describes capabilities and conversations", () => {
    const transport = new TelegramTransport({ account, fetchImpl: async () => jsonResponse({ ok: true, result: {} }) });
    const driver = new TelegramChannelDriver({
      transport,
      operatorId: "1001",
      logError: () => {},
    });
    expect(driver.id).toBe("telegram");
    expect(driver.capabilities.pushInbound).toBe(true);
    expect(driver.capabilities.streamingReplies).toBe(false);
    expect(driver.defaultConversation().conversationId).toBe("1001");
    expect(driver.buildInboundPrompt("hi", [])).toBe("hi");
  });

  test("maps send failures to failed status", async () => {
    const transport = new TelegramTransport({
      account,
      fetchImpl: async () =>
        jsonResponse({ ok: false, error_code: 400, description: "Bad request" }),
    });
    const driver = new TelegramChannelDriver({
      transport,
      operatorId: "1001",
      logError: () => {},
    });
    const result = await driver.sendText({
      target: { channelId: "telegram", conversationId: "1001", recipientId: "1001" },
      text: "hello",
      context: "message",
      log: () => {},
    });
    expect(result.status).toBe("failed");
  });
});
