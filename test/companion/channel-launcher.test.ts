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
  buildBackgroundBridgeArgs,
  formatAttachedBridgeMessage,
  parseCliArgs,
  resolveAttachedBridgeThreadId,
  tryDelegateToDaemon,
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
const state = {
  instanceId: lock.instanceId,
  adapter: lock.adapter,
  cwd,
  channelId: lock.channelId,
  sharedThreadId: threadId,
};
const attachOptions = { cwd, channelId: "telegram" as const };

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
    test(`${channelId} attach forwards its channel and clears prior bridge session state`, () => {
      const options = parseCliArgs([
        "--channel", channelId, "--attach-current-session",
        "--codex-thread-id", threadId, "--session-start-mode", "restore",
      ]);
      expect(options.channelId).toBe(channelId);
      expect(options.cliArgs).toEqual([]);
      const args = buildBackgroundBridgeArgs("/tmp/wechat-bridge.js", options);
      expect(args[args.indexOf("--channel") + 1]).toBe(channelId);
      expect(args[args.indexOf("--lifecycle") + 1]).toBe("persistent");
      expect(args[args.indexOf("--session-start-mode") + 1]).toBe("new");
      expect(args).toContain("--codex-attach-daemon");
      expect(args[args.indexOf("--codex-thread-id") + 1]).toBe(threadId);
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

    test(`${channelId} daemon success and fallback logs use the requesting launcher prefix`, async () => {
      const options = parseCliArgs(["--channel", channelId, "--adapter", "claude", "--cwd", cwd]);
      const output: string[] = [];
      const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      try {
        const deps = {
          readEndpoint: () => ({ protocolVersion: 1 as const, pid: 123, port: 9123,
            token: "test-token", cwd, startedAt: lock.startedAt, channelId }),
          isEndpointAlive: async () => true,
        };
        expect(await tryDelegateToDaemon(options, {
          ...deps, sendRequest: async () => ({ ok: true as const }),
        })).toBe(true);
        expect(await tryDelegateToDaemon(options, {
          ...deps, sendRequest: async () => ({ ok: false as const, error: "timeout" }),
        })).toBe(false);
      } finally {
        write.mockRestore();
      }
      expect(output).toEqual([
        `[${channelId}-claude] Delegated to running ${channelId}-daemon for ${cwd}.\n`,
        `[${channelId}-claude] Daemon delegation failed (timeout). Falling back to a local bridge.\n`,
      ]);
    });
  }

  test("omitted channel retains WeChat attach messages", () => {
    expect(formatAttachedBridgeMessage({ cwd }, threadId)).toContain("WeChat forwarding is active");
  });
});

describe("attach readiness", () => {
  test("accepts the active bridge instance, channel, workspace and explicit thread", () => {
    expect(resolveAttachedBridgeThreadId(state, lock, attachOptions)).toBe(threadId);
    expect(resolveAttachedBridgeThreadId(state, lock, { ...attachOptions, codexThreadId: threadId })).toBe(threadId);
  });

  test("rejects persisted state from the replaced bridge", () => {
    expect(resolveAttachedBridgeThreadId({ ...state, instanceId: "previous-bridge" }, lock, attachOptions)).toBeNull();
    expect(resolveAttachedBridgeThreadId(state, null, attachOptions)).toBeNull();
  });

  test("rejects state and locks belonging to another channel or workspace", () => {
    for (const update of [
      { channelId: "wechat" as const },
      { cwd: path.resolve("./tmp/another-project") },
      { adapter: "claude" as const },
    ]) {
      expect(resolveAttachedBridgeThreadId({ ...state, ...update }, lock, attachOptions)).toBeNull();
      expect(resolveAttachedBridgeThreadId(state, { ...lock, ...update }, attachOptions)).toBeNull();
    }
  });

  test("rejects incomplete state and an unexpected explicitly requested thread", () => {
    for (const invalid of [null, {}, { ...state, sharedThreadId: "" }, { ...state, sharedThreadId: 42 }]) {
      expect(resolveAttachedBridgeThreadId(invalid, lock, attachOptions)).toBeNull();
    }
    expect(resolveAttachedBridgeThreadId(state, lock, { ...attachOptions, codexThreadId: "another-thread" })).toBeNull();
  });

  test("legacy state without a channel id belongs only to WeChat", () => {
    const legacyState = { ...state, channelId: undefined };
    const legacyLock = { ...lock, channelId: undefined };
    expect(resolveAttachedBridgeThreadId(legacyState, legacyLock, { cwd })).toBe(threadId);
    expect(resolveAttachedBridgeThreadId(legacyState, legacyLock, attachOptions)).toBeNull();
  });
});
