// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { setLocale } from "../../src/i18n/index.ts";

import {
  buildCodexThreadResumeParams,
  buildCodexTurnStartParams,
  resolveCodexDaemonControlSocketPath,
  selectCodexDaemonAttachCandidates,
} from "../../src/bridge/bridge-adapters.codex.ts";
import { parseCliArgs as parseStartCliArgs } from "../../src/companion/local-companion-start.ts";

beforeEach(() => setLocale("en"));

function thread(
  id: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    cwd,
    parentThreadId: null,
    canAcceptDirectInput: null,
    status: { type: "notLoaded" },
    originator: "codex-tui",
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("selectCodexDaemonAttachCandidates", () => {
  const cwd = path.resolve("tmp/daemon-attach-project");

  test("keeps only live same-cwd root threads", () => {
    const candidates = selectCodexDaemonAttachCandidates(
      {
        data: [
          thread("live", cwd, { status: { type: "idle" }, updatedAt: 2_000 }),
          thread("not_loaded", cwd, { updatedAt: 3_000 }),
          thread("foreign", path.resolve("tmp/other"), { status: { type: "running" } }),
          thread("child", cwd, { status: { type: "running" }, parentThreadId: "root" }),
          thread("blocked", cwd, { status: { type: "running" }, canAcceptDirectInput: false }),
          thread("bridge_owned", cwd, { status: { type: "running" }, originator: "wechat-bridge" }),
        ],
      },
      cwd,
    );
    expect(candidates.map((candidate) => candidate.id)).toEqual(["live"]);
  });

  test("sorts newest activity first and reports originator", () => {
    const candidates = selectCodexDaemonAttachCandidates(
      {
        data: [
          thread("older", cwd, { status: { type: "idle" }, updatedAt: 1_000 }),
          thread("newer", cwd, { status: { type: "running" }, updatedAt: 9_000 }),
        ],
      },
      cwd,
    );
    expect(candidates.map((candidate) => candidate.id)).toEqual(["newer", "older"]);
    expect(candidates[0]).toEqual({ id: "newer", updatedAt: 9_000, originator: "codex-tui" });
  });

  test("returns empty for invalid payloads", () => {
    expect(selectCodexDaemonAttachCandidates(null, cwd)).toEqual([]);
    expect(selectCodexDaemonAttachCandidates({ data: "nope" }, cwd)).toEqual([]);
  });
});

describe("daemon-attach rpc params", () => {
  const cwd = path.resolve("tmp/daemon-attach-project");

  test("attach resume omits settings overrides", () => {
    expect(
      buildCodexThreadResumeParams({ threadId: "t1", cwd, attachDaemon: true }),
    ).toEqual({ threadId: "t1", excludeTurns: true });
  });

  test("owned resume keeps the full override set", () => {
    expect(
      buildCodexThreadResumeParams({ threadId: "t1", cwd, attachDaemon: false }),
    ).toEqual({
      threadId: "t1",
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
  });

  test("attach turn inherits thread settings", () => {
    expect(
      buildCodexTurnStartParams({ threadId: "t1", text: "hi", cwd, attachDaemon: true }),
    ).toEqual({ threadId: "t1", input: [{ type: "text", text: "hi" }] });
  });

  test("owned turn keeps cwd and approval routing", () => {
    expect(
      buildCodexTurnStartParams({ threadId: "t1", text: "hi", cwd, attachDaemon: false }),
    ).toEqual({
      threadId: "t1",
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      input: [{ type: "text", text: "hi" }],
    });
  });
});

describe("resolveCodexDaemonControlSocketPath", () => {
  test("uses CODEX_HOME when set", () => {
    expect(resolveCodexDaemonControlSocketPath("/custom/codex-home")).toBe(
      path.join("/custom/codex-home", "app-server-control", "app-server-control.sock"),
    );
  });

  test("falls back to ~/.codex and ignores blank env values", () => {
    const expected = path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
    expect(resolveCodexDaemonControlSocketPath(undefined)).toBe(expected);
    expect(resolveCodexDaemonControlSocketPath("   ")).toBe(expected);
  });
});

describe("daemon-attach CLI parsing", () => {
  test("wechat-codex launcher parses attach flags", () => {
    const options = parseStartCliArgs([
      "--adapter",
      "codex",
      "--cwd",
      "/tmp/project",
      "--attach-current-session",
      "--codex-thread-id",
      "thread-2",
    ]);
    expect(options.attachCurrentSession).toBe(true);
    expect(options.codexThreadId).toBe("thread-2");
  });

  test("wechat-codex launcher rejects attach for other adapters", () => {
    expect(() =>
      parseStartCliArgs(["--adapter", "pi", "--attach-current-session"]),
    ).toThrow(/requires the codex adapter/);
  });
});
