// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isDirectModuleRun(
  importMetaUrl: string,
  argv: string[] = process.argv,
  importMetaMain?: boolean,
): boolean {
  if (typeof importMetaMain === "boolean") {
    return importMetaMain;
  }
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }
  return normalizeComparablePath(fileURLToPath(importMetaUrl)) ===
    normalizeComparablePath(entryPath);
}
