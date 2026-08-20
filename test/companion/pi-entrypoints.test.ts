import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Pi CLI entrypoints", () => {
  test("exposes bridge, companion, and start commands", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.bin?.["wechat-bridge-pi"]).toBe("bin/wechat-bridge-pi.mjs");
    expect(packageJson.bin?.["wechat-pi"]).toBe("bin/wechat-pi.mjs");
    expect(packageJson.bin?.["wechat-pi-start"]).toBe("bin/wechat-pi-start.mjs");
    expect(packageJson.scripts?.["bridge:pi"]).toContain("--adapter pi");
    expect(packageJson.scripts?.["pi:companion"]).toContain("--adapter pi");
    expect(packageJson.scripts?.["pi:start"]).toContain("--adapter pi");
  });

  test("routes Pi through the shared local companion", () => {
    expect(readRepoFile("bin/wechat-pi.mjs")).toContain(
      'runJsEntry("dist/companion/local-companion.js", ["--adapter", "pi"])',
    );
    expect(readRepoFile("bin/wechat-pi-start.mjs")).toContain(
      'runJsEntry("dist/companion/local-companion-start.js", ["--adapter", "pi"])',
    );
    expect(readRepoFile("bin/wechat-bridge-pi.mjs")).toContain(
      'runJsEntry("dist/bridge/wechat-bridge.js", ["--adapter", "pi"])',
    );
  });
});
