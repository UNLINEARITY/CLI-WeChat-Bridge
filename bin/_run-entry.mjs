#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BIN_DIR, "..");
const MIN_NODE_MAJOR = 24;

function ensureSupportedNodeVersion() {
  if (process.env.CLI_BRIDGE_SKIP_NODE_CHECK === "1") {
    return;
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return;
  }

  process.stderr.write(
    [
      `[cli-wechat-bridge] Node.js >= ${MIN_NODE_MAJOR} is required, but you are running ${process.version}.`,
      `[cli-wechat-bridge] 需要 Node.js >= ${MIN_NODE_MAJOR}，当前版本为 ${process.version}。`,
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

export function runDeprecatedJsEntry(
  commandName,
  replacementCommand,
  relativeEntryPath,
  extraArgs = [],
) {
  process.stderr.write(
    `[cli-wechat-bridge] ${commandName} is deprecated; use ${replacementCommand}. This alias will be removed in the next release.\n`,
  );
  runJsEntry(relativeEntryPath, extraArgs);
}
