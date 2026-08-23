import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const AGENTS = ["codex", "claude", "opencode", "pi"] as const;

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("agent CLI entrypoints", () => {
  test("publishes the smart launchers and one-release start aliases", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(Object.keys(packageJson.bin ?? {}).sort()).toEqual([
      "wechat-check-update",
      "wechat-claude",
      "wechat-claude-start",
      "wechat-codex",
      "wechat-codex-start",
      "wechat-daemon",
      "wechat-opencode",
      "wechat-opencode-start",
      "wechat-pi",
      "wechat-pi-start",
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

    test(`wechat-${agent}-start is a deprecated alias`, () => {
      const source = readRepoFile(`bin/wechat-${agent}-start.mjs`);

      expect(source).toContain("runDeprecatedJsEntry(");
      expect(source).toContain(`"wechat-${agent}-start"`);
      expect(source).toContain(`"wechat-${agent}"`);
      expect(source).toContain('"dist/companion/local-companion-start.js"');
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

  test("centralizes the transition warning", () => {
    const source = readRepoFile("bin/_run-entry.mjs");

    expect(source).toContain("export function runDeprecatedJsEntry");
    expect(source).toContain("This alias will be removed in the next release.");
  });
});
