#!/usr/bin/env node

import { runDeprecatedJsEntry } from "./_run-entry.mjs";

runDeprecatedJsEntry(
  "wechat-codex-start",
  "wechat-codex",
  "dist/companion/local-companion-start.js",
  ["--adapter", "codex"],
);
