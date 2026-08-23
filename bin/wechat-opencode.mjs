#!/usr/bin/env node

import { runJsEntry } from "./_run-entry.mjs";

runJsEntry("dist/companion/local-companion-start.js", ["--adapter", "opencode"]);
