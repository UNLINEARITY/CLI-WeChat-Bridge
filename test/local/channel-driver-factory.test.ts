// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { createChannelDriver } from "../../src/channels/channel-driver-factory.ts";
import type { WeChatTransport } from "../../src/wechat/wechat-transport.ts";
import type { WecomTransport } from "../../src/channels/wecom/wecom-transport.ts";

const noop = () => {};

const fakeWechatTransport = { stop: noop } as unknown as WeChatTransport;
const fakeWecomTransport = { stop: noop } as unknown as WecomTransport;

describe("createChannelDriver", () => {
  test("builds the local loopback driver from explicit file paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-factory-"));
    const driver = createChannelDriver({
      channelId: "local",
      authorizedUserId: "local-operator",
      wechatTransport: null,
      wecomTransport: null,
      localFiles: {
        inboxFile: path.join(dir, "local-inbox.jsonl"),
        transcriptFile: path.join(dir, "local-transcript.jsonl"),
      },
      buildWechatInboundPrompt: (text) => text,
      log: noop,
      logError: noop,
    });
    expect(driver.id).toBe("local");
    expect(driver.capabilities.pushInbound).toBe(true);
  });

  test("rejects the local channel without inbox and transcript paths", () => {
    let failure = "";
    try {
      createChannelDriver({
        channelId: "local",
        authorizedUserId: "local-operator",
        wechatTransport: null,
        wecomTransport: null,
        buildWechatInboundPrompt: (text) => text,
        log: noop,
        logError: noop,
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("local channel requires inbox and transcript");
  });

  test("requires the matching transport for wechat and wecom", () => {
    expect(() =>
      createChannelDriver({
        channelId: "wechat",
        authorizedUserId: "u",
        wechatTransport: null,
        wecomTransport: fakeWecomTransport,
        buildWechatInboundPrompt: (text) => text,
        log: noop,
        logError: noop,
      }),
    ).toThrow("wechat channel requires a WeChat transport");

    expect(() =>
      createChannelDriver({
        channelId: "wecom",
        authorizedUserId: "u",
        wechatTransport: fakeWechatTransport,
        wecomTransport: null,
        buildWechatInboundPrompt: (text) => text,
        log: noop,
        logError: noop,
      }),
    ).toThrow("wecom channel requires a WeCom transport");

    expect(
      createChannelDriver({
        channelId: "wechat",
        authorizedUserId: "u",
        wechatTransport: fakeWechatTransport,
        wecomTransport: null,
        buildWechatInboundPrompt: (text) => text,
        log: noop,
        logError: noop,
      }).id,
    ).toBe("wechat");

    expect(
      createChannelDriver({
        channelId: "wecom",
        authorizedUserId: "u",
        wechatTransport: null,
        wecomTransport: fakeWecomTransport,
        buildWechatInboundPrompt: (text) => text,
        log: noop,
        logError: noop,
      }).id,
    ).toBe("wecom");
  });
});
