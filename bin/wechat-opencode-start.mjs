#!/usr/bin/env node

import { runDeprecatedJsEntry } from "./_run-entry.mjs";

runDeprecatedJsEntry(
  "wechat-opencode-start",
  "wechat-opencode",
  "dist/companion/local-companion-start.js",
  ["--adapter", "opencode"],
);
