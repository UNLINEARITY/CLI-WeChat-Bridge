#!/usr/bin/env node

// Generic launcher: wechat-claude-multi-start <N> [...args]
//   Example: wechat-claude-multi-start 5 --cwd D:\project-A
//   Equivalent to: wechat-claude-start --instance 5 --cwd D:\project-A
//
// WeChat side: /claude@5 routes messages to this instance.

import { runJsEntry } from "./_run-entry.mjs";

const args = process.argv.slice(2);
const instance = args[0];
const rest = args.slice(1);

if (!instance || !/^\d+$/.test(instance)) {
  process.stderr.write(
    "Usage: wechat-claude-multi-start <instance> [--cwd <path>] [...claude args]\n" +
    "  Example: wechat-claude-multi-start 1 --cwd D:\\project-A\n" +
    "  Example: wechat-claude-multi-start 5\n\n" +
    "Creates a numbered Claude slot that can be addressed via /claude@<instance> in WeChat.\n",
  );
  process.exit(1);
}

// Strip the instance arg so runJsEntry doesn't forward it as a raw CLI arg.
// runJsEntry appends process.argv.slice(2) after extraArgs, so we must remove
// the instance number from argv to avoid it reaching Claude Code as garbage input.
process.argv = [process.argv[0], process.argv[1], ...rest];

runJsEntry("dist/companion/local-companion-start.js", [
  "--adapter", "claude",
  "--instance", instance,
]);
