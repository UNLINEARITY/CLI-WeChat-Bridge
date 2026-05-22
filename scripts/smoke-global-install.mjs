#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const PACKAGE_JSON = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
const PACKAGE_NAME = String(PACKAGE_JSON.name ?? "");
const COMPAT_PACKAGE_NAMES = ["@unlinearity/cli-wechat-bridge"];
const BIN_MAP = PACKAGE_JSON.bin && typeof PACKAGE_JSON.bin === "object" ? PACKAGE_JSON.bin : {};
const NPM_EXEC_PATH = process.env.npm_execpath;

const NPM_COMMAND = NPM_EXEC_PATH
  ? {
      command: process.execPath,
      argsPrefix: [NPM_EXEC_PATH],
    }
  : {
      command: "npm",
      argsPrefix: [],
    };

function log(message) {
  process.stdout.write(`[smoke-global] ${message}\n`);
}

function quoteArg(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function formatCommand(command, args) {
  return [command, ...args.map(quoteArg)].join(" ");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      details
        ? `Command failed: ${formatCommand(command, args)}\n${details}`
        : `Command failed: ${formatCommand(command, args)}`,
    );
  }

  return result;
}

function runNpm(args, options = {}) {
  return runCommand(
    NPM_COMMAND.command,
    [...NPM_COMMAND.argsPrefix, ...args],
    options,
  );
}

function parseArgs(argv) {
  const options = {
    cleanCache: false,
    full: false,
    keepTarball: false,
    purgeGlobal: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--clean-cache") {
      options.cleanCache = true;
      continue;
    }

    if (arg === "--full") {
      options.full = true;
      continue;
    }

    if (arg === "--keep-tarball" || arg === "--keep-temp") {
      options.keepTarball = true;
      continue;
    }

    if (arg === "--purge-global") {
      options.purgeGlobal = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: npm run smoke:global -- [--clean-cache] [--full] [--keep-tarball] [--purge-global]",
      "",
      "Creates a real npm package tarball from the local source tree, installs it into your real npm global prefix, and verifies the installed CLI commands from outside the repository.",
      "Default behavior:",
      "  - package tarball is built from the current local code",
      "  - the tarball is installed with npm install -g",
      "  - global commands remain available after the script exits",
      "  - interactive or networked commands stay out of the default smoke path",
      "",
      "Options:",
      "  --clean-cache   Run npm cache clean --force before packing",
      "  --full          Run npm run quality after the smoke install",
      "  --keep-tarball  Keep the generated tarball for inspection",
      "  --purge-global  Uninstall the currently installed global package first",
      "",
    ].join("\n"),
  );
}

function isSafeSmokeCommand(commandName) {
  return (
    commandName === "wechat-codex" ||
    commandName === "wechat-claude" ||
    commandName === "wechat-opencode" ||
    commandName === "wechat-daemon" ||
    commandName.startsWith("wechat-bridge") ||
    commandName.endsWith("-start")
  );
}

function getSmokeCommands() {
  return Object.keys(BIN_MAP)
    .filter((commandName) => commandName !== "wechat-setup" && commandName !== "wechat-check-update")
    .filter(isSafeSmokeCommand)
    .sort();
}

function resolvePackTarballPath(packResult) {
  const payload = JSON.parse(packResult.stdout.trim());
  const packInfo = Array.isArray(payload) ? payload[payload.length - 1] : payload;
  const tarballName =
    packInfo?.filename ??
    packInfo?.path ??
    packInfo?.tarball ??
    null;

  if (!tarballName || typeof tarballName !== "string") {
    throw new Error(`Unable to read npm pack output for ${PACKAGE_NAME}.`);
  }

  return path.isAbsolute(tarballName) ? tarballName : path.join(REPO_ROOT, tarballName);
}

function resolveGlobalRoot() {
  const rootResult = runNpm([
    "root",
    "-g",
    "--silent",
  ]);
  const candidate = rootResult.stdout.trim();
  if (candidate) {
    return candidate;
  }

  throw new Error("Unable to resolve the npm global root.");
}

function resolveGlobalPrefix() {
  const prefixResult = runNpm([
    "prefix",
    "-g",
    "--silent",
  ]);
  const candidate = prefixResult.stdout.trim();
  if (candidate) {
    return candidate;
  }

  throw new Error("Unable to resolve the npm global prefix.");
}

function locateGlobalBinDir(prefix, commands) {
  const candidates = [
    prefix,
    path.join(prefix, "bin"),
    path.join(prefix, "Scripts"),
    path.join(prefix, "node_modules", ".bin"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const hasAllCommands = commands.every((commandName) =>
      [
        path.join(candidate, commandName),
        path.join(candidate, `${commandName}.cmd`),
        path.join(candidate, `${commandName}.ps1`),
      ].some((filePath) => fs.existsSync(filePath)),
    );

    if (hasAllCommands) {
      return candidate;
    }
  }

  return null;
}

function runInstalledCommandFromPackageRoot(commandName, packageRoot, args) {
  const entryPath = path.join(packageRoot, "bin", `${commandName}.mjs`);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Missing installed entrypoint: ${entryPath}`);
  }

  runCommand(process.execPath, [entryPath, ...args], {
    stdio: "pipe",
  });
}

function runInstalledCommandViaUserPath(commandName, args) {
  if (process.platform === "win32") {
    runCommand(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        ["call", commandName, ...args].join(" "),
      ],
      {
        cwd: os.homedir(),
        stdio: "pipe",
      },
    );
    return;
  }

  runCommand(commandName, args, {
    cwd: os.homedir(),
    stdio: "pipe",
  });
}

function removePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
}

function resolveGlobalPackageRoot(globalRoot, packageName) {
  return path.join(globalRoot, ...packageName.split("/"));
}

function getGlobalPackageNamesToPurge() {
  return [...new Set([PACKAGE_NAME, ...COMPAT_PACKAGE_NAMES])];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const smokeCommands = getSmokeCommands();
  if (smokeCommands.length === 0) {
    throw new Error("No safe smoke commands were found in package.json bin.");
  }

  let tarballPath = "";

  try {
    if (options.cleanCache) {
      log("Cleaning npm cache...");
      runNpm([
        "cache",
        "clean",
        "--force",
        "--silent",
      ], { stdio: "inherit" });
    }

    if (options.purgeGlobal) {
      const packageNamesToPurge = getGlobalPackageNamesToPurge();
      log(`Purging any currently installed global copy of ${packageNamesToPurge.join(" or ")}...`);
      const globalRootResult = runNpm([
        "root",
        "-g",
        "--silent",
      ]);
      const globalRoot = globalRootResult.stdout.trim();
      let purgedAny = false;

      for (const packageName of packageNamesToPurge) {
        const globalPackageRoot = globalRoot
          ? resolveGlobalPackageRoot(globalRoot, packageName)
          : "";
        if (!globalPackageRoot || !fs.existsSync(globalPackageRoot)) {
          continue;
        }
        purgedAny = true;
        runNpm([
          "uninstall",
          "-g",
          packageName,
          "--silent",
          "--no-fund",
          "--no-audit",
        ], { stdio: "inherit" });
      }

      if (!purgedAny) {
        log("No installed global copy was found.");
      }
    }

    log("Packing repository into a real npm tarball...");
    const packResult = runNpm([
      "pack",
      "--json",
      "--silent",
    ]);
    tarballPath = resolvePackTarballPath(packResult);
    log(`Tarball: ${path.relative(REPO_ROOT, tarballPath)}`);

    log("Installing tarball into the real npm global prefix...");
    runNpm([
      "install",
      "-g",
      tarballPath,
      "--silent",
      "--no-fund",
      "--no-audit",
    ], { stdio: "inherit" });

    const globalRoot = resolveGlobalRoot();
    const globalPrefix = resolveGlobalPrefix();
    const packageRoot = path.join(globalRoot, PACKAGE_NAME);
    if (!fs.existsSync(packageRoot)) {
      throw new Error(`Installed package root was not found: ${packageRoot}`);
    }

    const binDir = locateGlobalBinDir(globalPrefix, smokeCommands);
    if (!binDir) {
      throw new Error(`Installed package was found, but npm global command shims were not found under ${globalPrefix}.`);
    }

    log(`Verified global shim directory: ${binDir}`);
    for (const commandName of smokeCommands) {
      log(`Smoke testing ${commandName} from ${os.homedir()} via user PATH...`);
      try {
        runInstalledCommandViaUserPath(commandName, ["--help"]);
      } catch (error) {
        runInstalledCommandFromPackageRoot(commandName, packageRoot, ["--help"]);
        throw new Error(
          `${commandName} is installed under ${binDir}, but it is not visible on the current PATH. Add that directory to PATH, reopen the terminal, and retry.`,
          { cause: error },
        );
      }
    }

    if (options.full) {
      log("Running the full quality gate...");
      runNpm(["run", "quality"], { stdio: "inherit" });
    }

    log("Smoke test completed successfully.");
  } finally {
    if (!options.keepTarball) {
      removePath(tarballPath);
    } else if (tarballPath) {
      log(`Keeping tarball at ${tarballPath}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[smoke-global] ERROR: ${message}\n`);
  process.exit(1);
});
