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
