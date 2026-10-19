// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import { isPidAlive, normalizeDaemonEndpoint } from "../../src/daemon/daemon-link.ts";

describe("daemon-link isPidAlive", () => {
  test("rejects invalid pids", () => {
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });

  test("returns true when process.kill succeeds", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("treats EPERM as alive (process exists under another privilege level)", () => {
    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }) as typeof process.kill;
    try {
      expect(isPidAlive(4321)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  test("treats ESRCH as dead", () => {
    const originalKill = process.kill;
    process.kill = (() => {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }) as typeof process.kill;
    try {
      expect(isPidAlive(4321)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });
});

describe("daemon-link normalizeDaemonEndpoint", () => {
  const base = {
    protocolVersion: 1,
    pid: 4321,
    port: 50000,
    token: "token",
    cwd: "/tmp/project",
    startedAt: "2026-10-19T00:00:00.000Z",
  };

  test("keeps every known channel id", () => {
    for (const channelId of ["wechat", "wecom", "telegram", "local"]) {
      expect(normalizeDaemonEndpoint({ ...base, channelId })?.channelId).toBe(channelId);
    }
  });

  test("drops an unknown channel id", () => {
    expect(normalizeDaemonEndpoint({ ...base, channelId: "slack" })).toEqual(base);
  });
});
