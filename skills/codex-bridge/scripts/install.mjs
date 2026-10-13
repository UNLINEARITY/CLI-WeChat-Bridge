// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function installCodexBridgeSkill({
  sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
} = {}) {
  const targetDir = path.join(codexHome, "skills", "codex-bridge");
  for (const relative of ["SKILL.md", "agents/openai.yaml", "scripts/install.mjs"]) {
    const source = path.join(sourceDir, relative);
    const target = path.join(targetDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
  }
  return targetDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ installed: installCodexBridgeSkill() }));
}
