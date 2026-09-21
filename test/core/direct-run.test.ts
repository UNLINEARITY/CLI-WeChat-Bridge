// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isDirectModuleRun } from "../../src/core/direct-run.ts";

describe("direct module entry detection", () => {
  test("uses import.meta.main when the runtime provides it", () => {
    expect(isDirectModuleRun("file:///unused.js", [], true)).toBe(true);
    expect(isDirectModuleRun("file:///unused.js", ["node", "unused.js"], false)).toBe(false);
  });

  test("falls back to argv on Node versions without import.meta.main", () => {
    const entryPath = path.resolve("dist/bridge/wechat-bridge.js");
    const entryUrl = pathToFileURL(entryPath).href;
    expect(isDirectModuleRun(entryUrl, ["node", entryPath], undefined)).toBe(true);
    expect(
      isDirectModuleRun(entryUrl, ["node", path.resolve("dist/other.js")], undefined),
    ).toBe(false);
  });
});
