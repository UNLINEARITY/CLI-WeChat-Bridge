#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BIN_DIR, "..");
export const MIN_NODE_VERSION = Object.freeze([22, 13, 0]);
export const MIN_NODE_VERSION_TEXT = MIN_NODE_VERSION.join(".");

export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (!match) {
    return false;
  }

  const current = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if (current[index] !== MIN_NODE_VERSION[index]) {
      return current[index] > MIN_NODE_VERSION[index];
    }
  }
  return true;
}

function ensureSupportedNodeVersion() {
  if (process.env.CLI_BRIDGE_SKIP_NODE_CHECK === "1") {
    return;
  }

  if (isSupportedNodeVersion(process.versions.node)) {
    return;
  }

  process.stderr.write(
    [
      `[cli-wechat-bridge] Node.js >= ${MIN_NODE_VERSION_TEXT} is required, but you are running ${process.version}.`,
      `[cli-wechat-bridge] 需要 Node.js >= ${MIN_NODE_VERSION_TEXT}，当前版本为 ${process.version}。`,
      "Install the latest LTS from https://nodejs.org/ (or via nvm), then retry.",
      "Set CLI_BRIDGE_SKIP_NODE_CHECK=1 to bypass this check at your own risk.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

export function runJsEntry(relativeEntryPath, extraArgs = []) {
  ensureSupportedNodeVersion();
  const entryPath = path.join(PROJECT_DIR, relativeEntryPath);
  const child = spawn(
    process.execPath,
    [entryPath, ...extraArgs, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    },
  );

  child.once("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
