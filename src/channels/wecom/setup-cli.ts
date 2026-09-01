#!/usr/bin/env node

import { runWecomSetup } from "./setup.ts";

runWecomSetup().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
