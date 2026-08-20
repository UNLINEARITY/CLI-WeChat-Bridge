#!/usr/bin/env node

import { runJsEntry } from "./_run-entry.mjs";

runJsEntry("dist/bridge/wechat-bridge.js", ["--adapter", "pi"]);
