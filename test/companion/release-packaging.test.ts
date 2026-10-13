// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMirrorPackage } from "../../scripts/publish-dual.mjs";
import { getSmokeCommands } from "../../scripts/smoke-global-install.mjs";

const repoRoot = path.resolve(import.meta.dir, "../..");
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const packageJson = JSON.parse(read("package.json"));

describe("release package metadata", () => {
  test("keeps the root versions and command inventories aligned", () => {
    const lock = JSON.parse(read("package-lock.json"));
    const bunVersion = read("bun.lock").match(/"workspaces":\s*\{\s*"":\s*\{[\s\S]*?"version":\s*"([^"]+)"/)?.[1];
    expect(packageJson.name).toBe("cli-wechat-bridge");
    expect(lock.version).toBe(packageJson.version);
    expect(lock.packages[""].version).toBe(packageJson.version);
    expect(bunVersion).toBe(packageJson.version);
    expect(lock.packages[""].bin).toEqual(packageJson.bin);
    expect(packageJson.files).toContain("README.md");
    expect(packageJson.files).toContain("README_EN.md");
  });

  test("smokes every channel launcher while excluding network and pairing commands", () => {
    const expected = ["wechat", "wecom", "telegram"].flatMap((channel) =>
      ["codex", "claude", "opencode", "pi", "daemon"].map((adapter) => `${channel}-${adapter}`),
    ).sort();
    expect(getSmokeCommands({ ...packageJson.bin, "unknown-command": "bin/unknown.mjs" })).toEqual(expected);
    expect(expected).toHaveLength(15);
  });

  test("the scoped mirror includes both READMEs, commands and skill without local state", () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-package-source-"));
    for (const entry of ["bin", "skills", "scripts/ensure-node-pty-permissions.mjs", "README.md", "README_EN.md", "LICENSE.txt"]) {
      const target = path.join(sourceRoot, entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(repoRoot, entry), target, { recursive: true });
    }
    fs.mkdirSync(path.join(sourceRoot, "dist"));
    fs.writeFileSync(path.join(sourceRoot, "dist", "fixture.js"), "// SPDX-License-Identifier: AGPL-3.0-or-later\n");
    for (const entry of ["log.md", "git-log.md", "account.json", "bridge.log"]) {
      fs.writeFileSync(path.join(sourceRoot, entry), "local-only fixture\n");
    }
    for (const entry of ["src", "test", "node_modules", "docs"]) {
      fs.mkdirSync(path.join(sourceRoot, entry));
    }
    const directory = createMirrorPackage(packageJson, sourceRoot);
    try {
      const mirror = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      expect(mirror.name).toBe("@unlinearity/cli-wechat-bridge");
      expect(mirror.version).toBe(packageJson.version);
      expect(mirror.bin).toEqual(packageJson.bin);
      expect(mirror.scripts).toEqual({ postinstall: packageJson.scripts.postinstall });
      expect(mirror.devDependencies).toBeUndefined();
      expect(fs.existsSync(path.join(directory, "dist", "fixture.js"))).toBe(true);
      for (const file of ["README.md", "README_EN.md", "LICENSE.txt", "skills/codex-bridge/SKILL.md"]) {
        expect(fs.readFileSync(path.join(directory, file), "utf8")).toBe(read(file));
      }
      for (const entry of Object.values(packageJson.bin) as string[]) {
        expect(fs.existsSync(path.join(directory, entry))).toBe(true);
        if (process.platform !== "win32") {
          expect(fs.statSync(path.join(directory, entry)).mode & 0o111).not.toBe(0);
        }
      }
      for (const forbidden of ["log.md", "git-log.md", "account.json", "bridge.log", "src", "test", "node_modules", "docs"]) {
        expect(fs.existsSync(path.join(directory, forbidden))).toBe(false);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});
