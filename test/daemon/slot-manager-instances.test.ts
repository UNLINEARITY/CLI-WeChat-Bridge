// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { AdapterOptions } from "../../src/bridge/bridge-adapters.shared.ts";
import type { BridgeAdapter, BridgeAdapterState } from "../../src/bridge/bridge-types.ts";
import type { DaemonAdapterKind } from "../../src/daemon/daemon-link.ts";
import { SlotManager } from "../../src/daemon/slot-manager.ts";
import type { SlotSessionRecord } from "../../src/daemon/slot-session-store.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fakeRuntime(options: AdapterOptions): BridgeAdapter {
  const state: BridgeAdapterState = {
    kind: options.kind,
    status: "idle",
    cwd: options.cwd,
    command: options.command,
  };
  return {
    setEventSink: () => undefined,
    start: async () => undefined,
    dispose: async () => undefined,
    getState: () => state,
  } as unknown as BridgeAdapter;
}

function buildManager() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slot-instances-"));
  tempDirectories.push(cwd);
  const created: AdapterOptions[] = [];
  const sessions = new Map<string, SlotSessionRecord>();
  const manager = new SlotManager({
    cwd,
    channelId: "wechat",
    operatorId: "operator",
    createRuntime: (options) => {
      created.push(options);
      return fakeRuntime(options);
    },
    isVisibleClientAlive: () => true,
    openVisibleClient: () => ({ command: "fake", args: [] }),
    queueMessage: async () => true,
    resolveSlotOutputTarget: () => ({ channelId: "wechat", conversationId: "operator" }) as never,
    onSlotEvent: () => undefined,
    sessions: {
      read: (slotCwd, adapter: DaemonAdapterKind, instance = 1) =>
        sessions.get(`${slotCwd}|${adapter}|${instance}`) ?? null,
      write: (slotCwd, adapter: DaemonAdapterKind, record, instance = 1) => {
        sessions.set(`${slotCwd}|${adapter}|${instance}`, record);
      },
    },
    isEphemeral: () => true,
    daemonLog: () => undefined,
  });
  return { cwd, manager, created };
}

describe("SlotManager numbered instances", () => {
  test("keeps two instances of one adapter side by side", async () => {
    const { cwd, manager, created } = buildManager();
    const first = await manager.ensureSlot("pi", { cwd, openVisible: false });
    const second = await manager.ensureSlot("pi", { cwd, openVisible: false, instance: 2 });

    expect(first.instance).toBe(1);
    expect(second.instance).toBe(2);
    expect(manager.instancesOf(cwd, "pi").map((slot) => slot.instance)).toEqual([1, 2]);
    // Only numbered instances tell their runtime which endpoint file to use.
    expect(created.map((options) => options.slotInstance)).toEqual([undefined, 2]);
  });

  test("tracks the active instance and defaults lookups to it", async () => {
    const { cwd, manager } = buildManager();
    await manager.ensureSlot("pi", { cwd, openVisible: false });
    await manager.ensureSlot("pi", { cwd, openVisible: false, instance: 2 });

    expect(manager.activeInstance).toBe(2);
    expect(manager.getActiveSlot()?.instance).toBe(2);
    expect(manager.getSlot(cwd, "pi")?.instance).toBe(2);
    expect(manager.getSlot(cwd, "pi", 1)?.instance).toBe(1);

    await manager.ensureSlot("pi", { cwd, openVisible: false, instance: 1 });
    expect(manager.getActiveSlot()?.instance).toBe(1);
  });

  test("releasing one instance leaves the other and its number untouched", async () => {
    const { cwd, manager } = buildManager();
    await manager.ensureSlot("pi", { cwd, openVisible: false });
    await manager.ensureSlot("pi", { cwd, openVisible: false, instance: 2 });

    manager.releaseSlot(manager.getSlot(cwd, "pi", 1)!);

    expect(manager.instancesOf(cwd, "pi").map((slot) => slot.instance)).toEqual([2]);
    expect(manager.getActiveSlot()?.instance).toBe(2);
  });
});
