#!/usr/bin/env node

// Ensure the bundled node-pty `spawn-helper` is executable.
//
// node-pty ships its prebuilt `spawn-helper` binaries with mode 0644 (no exec
// bit) in the published tarball. On macOS/Linux that makes `posix_spawnp`
// fail when node-pty tries to fork a PTY, so the bridge silently drops to the
// non-PTY fallback. The Claude adapter relies on PTY interactive mode, so the
// fallback surfaces to users as:
//
//   Error: Input must be provided ... when using --print
//
// Restoring the exec bit after install fixes PTY spawning. This runs on
// postinstall and is idempotent; it never fails the install.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform === "win32") {
  process.exit(0);
}

const require = createRequire(import.meta.url);

let nodePtyDir;
try {
  nodePtyDir = path.dirname(require.resolve("node-pty/package.json"));
} catch {
  // node-pty is optional in unsupported environments; nothing to fix.
  process.exit(0);
}

const candidates = [
  "prebuilds/darwin-arm64/spawn-helper",
  "prebuilds/darwin-x64/spawn-helper",
  "prebuilds/linux-x64/spawn-helper",
  "prebuilds/linux-arm64/spawn-helper",
  "build/Release/spawn-helper",
];

let fixed = 0;
for (const relative of candidates) {
  const helperPath = path.join(nodePtyDir, relative);
  let stats;
  try {
    stats = fs.statSync(helperPath);
  } catch {
    continue;
  }
  if (!stats.isFile()) {
    continue;
  }
  if ((stats.mode & 0o111) !== 0) {
    continue;
  }
  try {
    fs.chmodSync(helperPath, stats.mode | 0o755);
    fixed += 1;
  } catch (error) {
    console.warn(
      `[cli-wechat-bridge] Could not make node-pty spawn-helper executable: ${helperPath}\n` +
        `  ${error instanceof Error ? error.message : String(error)}\n` +
        "  PTY mode may be unavailable; run --doctor for details.",
    );
  }
}

if (fixed > 0) {
  console.log(
    `[cli-wechat-bridge] Restored executable bit on ${fixed} node-pty spawn-helper binary(ies).`,
  );
}
