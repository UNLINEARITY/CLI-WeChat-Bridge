// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";

import {
  BRIDGE_CHANNEL_DISPLAY_NAMES,
  getBridgeChannelDisplayName,
  isBridgeChannelId,
  normalizeBridgeChannelId,
} from "../../src/core/channel-types.ts";
import {
  formatAttachedBridgeMessage,
  parseCliArgs,
  claimDaemonSlot,
  connectToDaemon,
} from "../../src/companion/local-companion-start.ts";
import type { BridgeLockPayload } from "../../src/bridge/bridge-state.ts";

const launcher = path.resolve(import.meta.dir, "../../src/companion/local-companion-start.ts");
const channels = [
  ["wechat", "WeChat"],
  ["wecom", "WeCom"],
  ["telegram", "Telegram"],
] as const;
const cwd = path.resolve("./tmp/attach-project");
const threadId = "01a133e7-127d-7121-8a67-85ea48fcbbfd";

const lock: BridgeLockPayload = {
  pid: 123,
  parentPid: 321,
  instanceId: "current-bridge",
  adapter: "codex",
  command: "codex",
  cwd,
  startedAt: "2026-10-13T09:00:00.000Z",
  lifecycle: "persistent",
  channelId: "telegram",
};
describe("channel-aware companion launchers", () => {
  test("validates registered channels and preserves the legacy default", () => {
    for (const channelId of Object.keys(BRIDGE_CHANNEL_DISPLAY_NAMES)) {
      expect(isBridgeChannelId(channelId)).toBe(true);
      expect(normalizeBridgeChannelId(channelId)).toBe(channelId);
    }
    for (const value of [undefined, null, "unknown", "toString", "__proto__", 42]) {
      expect(isBridgeChannelId(value)).toBe(false);
      expect(normalizeBridgeChannelId(value)).toBe("wechat");
    }
    expect(getBridgeChannelDisplayName("local")).toBe("Local");
    expect(() => parseCliArgs(["--channel", "local"])).toThrow("Invalid channel");
    expect(() => parseCliArgs(["--channel", "unknown"])).toThrow("Invalid channel");
  });

  for (const [channelId, displayName] of channels) {
    test(`${channelId} attach keeps its channel and requested thread`, () => {
      const options = parseCliArgs([
        "--channel", channelId, "--attach-current-session",
        "--codex-thread-id", threadId, "--session-start-mode", "restore",
      ]);
      expect(options.channelId).toBe(channelId);
      expect(options.cliArgs).toEqual([]);
      expect(options.attachCurrentSession).toBe(true);
      expect(options.codexThreadId).toBe(threadId);
      expect(formatAttachedBridgeMessage(options, threadId)).toContain(`${displayName} forwarding is active`);
    });

    test(`${channelId} help identifies the selected runtime and attach channel`, () => {
      const result = Bun.spawnSync([
        process.execPath, launcher, "--channel", channelId, "--help",
      ]);
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain(`Usage: ${channelId}-codex`);
      expect(output).toContain(`Ensures the ${displayName} runtime`);
      expect(output).toContain(`attach ${displayName} to the live Codex daemon session`);
      expect(output).toContain("Codex starts a fresh session by default.");
      expect(output).toContain("Use --session-start-mode restore to explicitly restore the previous session.");
    });

    test(`${channelId} argument errors retain the channel and adapter prefix`, () => {
      const result = Bun.spawnSync([
        process.execPath, launcher, "--channel", channelId, "--adapter", "claude",
        "--timeout-ms", "invalid",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(`[${channelId}-claude] --timeout-ms must be a number >= 1000`);
    });

    test(`${channelId} daemon start and failure messages use the requesting launcher prefix`, async () => {
      const options = parseCliArgs(["--channel", channelId, "--adapter", "claude", "--cwd", cwd]);
      const endpoint = { protocolVersion: 1 as const, pid: 123, port: 9123,
        token: "test-token", cwd, startedAt: lock.startedAt, channelId };
      const output: string[] = [];
      const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      let current: typeof endpoint | null = null;
      try {
        await connectToDaemon(options, {
          readEndpoint: () => current,
          isEndpointAlive: async () => true,
          startDaemon: () => {
            current = endpoint;
          },
          sleep: async () => undefined,
        });
      } finally {
        write.mockRestore();
      }
      expect(output).toEqual([`[${channelId}-claude] Starting ${channelId} bridge for ${cwd}...\n`]);
      await expect(claimDaemonSlot(options, endpoint, {
        sendRequest: async () => ({ ok: false as const, error: "timeout" }),
      })).rejects.toThrow(`The ${channelId} bridge could not prepare claude for ${cwd}: timeout.`);
    });
  }

  test("omitted channel retains WeChat attach messages", () => {
    expect(formatAttachedBridgeMessage({ cwd }, threadId)).toContain("WeChat forwarding is active");
  });
});
