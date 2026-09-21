// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";

import { ensureChannelDataDir } from "../wechat/channel-config.ts";

/**
 * Write JSON atomically via temp file + rename, so a crash mid-write cannot
 * leave a truncated or half-written file behind. Cross-process readers (the
 * daemon, launchers, companions) either see the previous complete file or the
 * new complete file — never a torn write.
 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  ensureChannelDataDir();
  const data = JSON.stringify(value, null, 2);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, data, "utf-8");
  fs.renameSync(tempPath, filePath);
}
