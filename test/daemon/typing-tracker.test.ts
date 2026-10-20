// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import { TypingTracker } from "../../src/daemon/typing-tracker.ts";

function tracker() {
  const calls: string[] = [];
  const typing = new TypingTracker({
    beginTyping: async (recipientId) => { calls.push(`begin:${recipientId}`); },
    endTyping: async (recipientId) => { calls.push(`end:${recipientId}`); },
  }, () => undefined);
  return { typing, calls };
}

describe("TypingTracker", () => {
  test("ends only when no window still types for the recipient", () => {
    const { typing, calls } = tracker();
    const codex = { adapter: "codex" };
    const claude = { adapter: "claude" };
    typing.start(codex, "op");
    typing.start(claude, "op");
    typing.stop(codex, "task_complete");
    expect(calls).toEqual(["begin:op", "begin:op"]);
    typing.stop(claude, "task_complete");
    expect(calls.at(-1)).toBe("end:op");
    typing.stop(claude, "task_complete");
    expect(calls.filter((call) => call === "end:op")).toHaveLength(1);
  });

  test("ends for the recipient it started for", () => {
    const { typing, calls } = tracker();
    const slot = { adapter: "opencode" };
    typing.start(slot, "group-chat");
    typing.stop(slot, "final_reply");
    expect(calls).toEqual(["begin:group-chat", "end:group-chat"]);
  });

  test("pauses while waiting for the operator and resumes afterwards", () => {
    const { typing, calls } = tracker();
    const slot = { adapter: "codex" };
    typing.resume(slot);
    expect(calls).toEqual([]);
    typing.start(slot, "op");
    typing.pause(slot);
    typing.resume(slot);
    typing.pause(slot);
    typing.stop(slot, "task_complete");
    typing.resume(slot);
    expect(calls).toEqual(["begin:op", "end:op", "begin:op", "end:op"]);
  });
});
