#!/usr/bin/env bun

import {
  checkForUpdate,
  getCurrentVersion,
} from "../utils/version-checker.ts";

async function main(): Promise<void> {
  const currentVersion = await getCurrentVersion();

  console.log(`CLI WeChat Bridge Version Check`);
  console.log(`Current version: v${currentVersion}\n`);

  console.log(`Checking for updates...`);

  const versionInfo = await checkForUpdate(true); // 强制检查

  if (!versionInfo) {
    console.error(`ERROR: Unable to check for updates.`);
    console.error(
      `Could not read the latest version from the npm registry or GitHub.`,
    );
    console.error(`Possible causes:`);
    console.error(`  - No network connection`);
    console.error(
      `  - A proxy is required but not configured (set HTTP_PROXY/HTTPS_PROXY and NODE_USE_ENV_PROXY=1)`,
    );
    console.error(
      `  - The npm registry or GitHub API are temporarily unavailable`,
    );
    console.error(`\nCheck the latest release manually:`);
    console.error(
      `  https://github.com/UNLINEARITY/CLI-WeChat-Bridge/releases`,
    );
    // 不使用 process.exit():强制退出会打断 fetch 底层 handle 的关闭流程,
    // 在 Windows + Node 24 上触发 libuv 的 UV_HANDLE_CLOSING 断言崩溃。
    // 设置 exitCode 后让事件循环自然退出。
    process.exitCode = 1;
    return;
  }

  if (!versionInfo.hasUpdate) {
    console.log(`OK: Already up to date (v${versionInfo.latest})`);
    return;
  }

  console.log(`[New Version Available] v${versionInfo.latest}`);
  console.log(`Current version: v${versionInfo.current}\n`);

  console.log(`Update instructions:`);
  console.log(`   cd CLI-WeChat-Bridge`);
  console.log(`   git pull`);
  console.log(`   bun install`);
  console.log(`   npm install -g .\n`);

  console.log(`For more information:`);
  console.log(`   https://github.com/UNLINEARITY/CLI-WeChat-Bridge/releases`);
}

main().catch((error) => {
  console.error(`Error checking for updates: ${error.message}`);
  process.exitCode = 1;
});
