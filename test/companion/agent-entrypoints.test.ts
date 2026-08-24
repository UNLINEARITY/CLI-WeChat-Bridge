import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const AGENTS = ["codex", "claude", "opencode", "pi"] as const;

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("agent CLI entrypoints", () => {
  test("publishes only the supported smart launchers", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(Object.keys(packageJson.bin ?? {}).sort()).toEqual([
      "wechat-check-update",
      "wechat-claude",
      "wechat-codex",
      "wechat-daemon",
      "wechat-opencode",
      "wechat-pi",
      "wechat-setup",
    ]);
    expect(packageJson.scripts?.["bridge:shell"]).toBeUndefined();
  });

  for (const agent of AGENTS) {
    test(`wechat-${agent} runs the smart launcher`, () => {
      const source = readRepoFile(`bin/wechat-${agent}.mjs`);

      expect(source).toContain('runJsEntry("dist/companion/local-companion-start.js"');
      expect(source).toContain(`"--adapter", "${agent}"`);
    });

  }

  test("removes every public bridge wrapper", () => {
    for (const command of [
      "wechat-bridge",
      "wechat-bridge-codex",
      "wechat-bridge-claude",
      "wechat-bridge-opencode",
      "wechat-bridge-pi",
      "wechat-bridge-shell",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, "bin", `${command}.mjs`))).toBe(false);
    }
  });

  test("removes every expired start alias", () => {
    for (const agent of AGENTS) {
      expect(fs.existsSync(path.join(REPO_ROOT, "bin", `wechat-${agent}-start.mjs`))).toBe(false);
    }
  });
});
