// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { readCodexSessionMeta } from "../../src/bridge/bridge-adapters.shared.ts";

const tempDirectories: string[] = [];

function writeSessionFile(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-meta-test-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, "rollout.jsonl");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function metaLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "session_meta",
    payload: { id: "thread_1", cwd: "/repo", timestamp: "2026-10-20T00:00:00.000Z", ...extra },
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("readCodexSessionMeta", () => {
  test("reads the meta line without loading the rest of the rollout", () => {
    const filePath = writeSessionFile(`${metaLine()}\n${"x".repeat(2 * 1024 * 1024)}\n`);
    const readFileSync = spyOn(fs, "readFileSync");
    try {
      expect(readCodexSessionMeta(filePath)?.id).toBe("thread_1");
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      readFileSync.mockRestore();
    }
  });

  test("reads a meta line longer than one read chunk", () => {
    const instructions = "i".repeat(200 * 1024);
    const filePath = writeSessionFile(`${metaLine({ instructions })}\r\n{"type":"event_msg"}\n`);
    const meta = readCodexSessionMeta(filePath) as { id?: string; instructions?: string } | null;
    expect(meta?.id).toBe("thread_1");
    expect(meta?.instructions?.length).toBe(instructions.length);
  });

  test("reads a file holding only the meta line without a trailing newline", () => {
    expect(readCodexSessionMeta(writeSessionFile(metaLine()))?.cwd).toBe("/repo");
  });

  test("returns null for empty files and non-meta first lines", () => {
    expect(readCodexSessionMeta(writeSessionFile(""))).toBeNull();
    expect(readCodexSessionMeta(writeSessionFile('{"type":"event_msg"}\n'))).toBeNull();
  });
});
