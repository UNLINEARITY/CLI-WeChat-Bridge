#!/usr/bin/env node

import { runDeprecatedJsEntry } from "./_run-entry.mjs";

runDeprecatedJsEntry(
  "wechat-pi-start",
  "wechat-pi",
  "dist/companion/local-companion-start.js",
  ["--adapter", "pi"],
);
