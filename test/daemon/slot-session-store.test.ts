// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

// The data directory is fixed at module load, so the store runs in a child
// process with an isolated CLI_BRIDGE_DATA_DIR.
function runWithDataDir(script: string): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "slot-sessions-"));
  try {
    return execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: process.cwd(), env: { ...process.env, CLI_BRIDGE_DATA_DIR: dataDir }, encoding: "utf8" },
    ).trim();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("fileSlotSessionStore", () => {
  test("writes and reads a record per workspace and adapter", () => {
    const output = runWithDataDir(`
      import { fileSlotSessionStore } from "./src/daemon/slot-session-store.ts";
      fileSlotSessionStore.write("/work/app", "claude", { sharedSessionId: "s-1", transcriptPath: "/t.jsonl" });
      console.log(JSON.stringify([
        fileSlotSessionStore.read("/work/app", "claude"),
        fileSlotSessionStore.read("/work/app", "codex"),
        fileSlotSessionStore.read("/work/other", "claude"),
      ]));
    `);
    expect(JSON.parse(output)).toEqual([
      { sharedSessionId: "s-1", transcriptPath: "/t.jsonl" },
      null,
      null,
    ]);
  });

  test("falls back to the standalone bridge state of older versions", () => {
    const output = runWithDataDir(`
      import fs from "node:fs";
      import path from "node:path";
      import { getWorkspaceChannelPaths } from "./src/wechat/channel-config.ts";
      import { fileSlotSessionStore } from "./src/daemon/slot-session-store.ts";
      const { stateFile } = getWorkspaceChannelPaths("/work/app");
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        adapter: "claude", cwd: "/work/app", sharedSessionId: "legacy-1", resumeConversationId: "r-1",
      }));
      console.log(JSON.stringify([
        fileSlotSessionStore.read("/work/app", "claude"),
        fileSlotSessionStore.read("/work/app", "codex"),
      ]));
    `);
    expect(JSON.parse(output)).toEqual([
      { sharedSessionId: "legacy-1", resumeConversationId: "r-1" },
      null,
    ]);
  });
});
