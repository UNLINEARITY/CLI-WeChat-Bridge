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
