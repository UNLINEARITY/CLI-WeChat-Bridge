#!/usr/bin/env node

import { runDeprecatedJsEntry } from "./_run-entry.mjs";

runDeprecatedJsEntry(
  "wechat-claude-start",
  "wechat-claude",
  "dist/companion/local-companion-start.js",
  ["--adapter", "claude"],
);
