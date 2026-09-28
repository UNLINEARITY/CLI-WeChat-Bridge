// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import { LocalChannelPort } from "../../src/channels/local/local-channel-port.ts";
import type { ChannelOutput } from "../../src/core/channel-types.ts";

const localTarget = { channelId: "local", conversationId: "local-operator", recipientId: "local-operator" };

function buildOutput(overrides: Partial<ChannelOutput> = {}): ChannelOutput {
  return {
    target: localTarget,
    kind: "notice",
    text: "text",
    ...overrides,
  } as ChannelOutput;
}

describe("local channel port", () => {
  test("sends final replies raw with the final_reply context", async () => {
    const sent: Array<{ recipientId: string; text: string; context: string }> = [];
    const sentCallbacks: string[] = [];
    const port = new LocalChannelPort({
      sendText: async (recipientId, text, context) => {
        sent.push({ recipientId, text, context });
        return true;
      },
      prefixText: (adapter, text) => `[${adapter ?? "none"}] ${text}`,
      onTextSent: (adapter) => sentCallbacks.push(`sent:${adapter}`),
    });
    await expect(port.send(buildOutput({ kind: "final_reply", text: "done", adapter: "codex" }))).resolves.toBe(true);
    expect(sent).toEqual([{ recipientId: "local-operator", text: "[codex] done", context: "final_reply" }]);
    expect(sentCallbacks).toEqual(["sent:codex"]);
  });

  test("reports empty final replies without sending", async () => {
    const empties: string[] = [];
    let sends = 0;
    const port = new LocalChannelPort({
      sendText: async () => {
        sends += 1;
        return true;
      },
      onEmptyVisibleReply: (_adapter, rawText) => empties.push(rawText),
    });
    await expect(port.send(buildOutput({ kind: "final_reply", text: "   " }))).resolves.toBe(true);
    expect(sends).toBe(0);
    expect(empties).toEqual(["   "]);
  });

  test("forwards notices with their kind or metadata send context", async () => {
    const contexts: string[] = [];
    const port = new LocalChannelPort({
      sendText: async (_recipientId, _text, context) => {
        contexts.push(context);
        return true;
      },
    });
    await port.send(buildOutput({ kind: "approval_required", text: "approve?" }));
    await port.send(buildOutput({
      kind: "notice",
      text: "queued",
      metadata: { sendContext: "mirrored_user_input" },
    }));
    expect(contexts).toEqual(["approval_required", "mirrored_user_input"]);
  });

  test("rejects non-local targets and skips attachments without a sender", async () => {
    const port = new LocalChannelPort({ sendText: async () => true });
    await expect(port.send(buildOutput({
      target: { channelId: "wechat", conversationId: "u", recipientId: "u" },
    }))).rejects.toThrow("Local channel cannot send to wechat");
    await expect(port.send(buildOutput({
      text: undefined,
      attachment: { kind: "image", path: "/tmp/a.png" },
    }))).resolves.toBe(true);
  });
});
