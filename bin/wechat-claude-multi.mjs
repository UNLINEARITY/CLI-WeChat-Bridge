#!/usr/bin/env node

// Generic launcher: wechat-claude-multi <N> [...args]
//   Example: wechat-claude-multi 5 --cwd D:\project-A
//   Equivalent to: wechat-claude --instance 5 --cwd D:\project-A

import { runJsEntry } from "./_run-entry.mjs";

const args = process.argv.slice(2);
const instance = args[0];
const rest = args.slice(1);

if (!instance || !/^\d+$/.test(instance)) {
  process.stderr.write(
    "Usage: wechat-claude-multi <instance> [--cwd <path>] [...claude args]\n" +
    "  Example: wechat-claude-multi 1 --cwd D:\\project-A\n" +
    "  Example: wechat-claude-multi 5\n\n" +
    "Connects to a numbered Claude slot managed by wechat-daemon.\n",
  );
  process.exit(1);
}

// Strip the instance arg so runJsEntry doesn't forward it as a raw CLI arg.
process.argv = [process.argv[0], process.argv[1], ...rest];

runJsEntry("dist/companion/local-companion.js", [
  "--adapter", "claude",
  "--instance", instance,
]);
