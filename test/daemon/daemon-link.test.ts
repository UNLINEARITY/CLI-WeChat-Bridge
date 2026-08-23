import { describe, expect, test } from "bun:test";

import { isPidAlive } from "../../src/daemon/daemon-link.ts";

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
