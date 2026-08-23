#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const PRIMARY_PACKAGE_NAME = "cli-wechat-bridge";
const COMPAT_PACKAGE_NAME = "@unlinearity/cli-wechat-bridge";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const MIRROR_FILES = [
  "bin",
  "dist",
  "scripts/ensure-node-pty-permissions.mjs",
  "README.md",
  "LICENSE.txt",
];
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
  process.stdout.write(`[publish-dual] ${message}\n`);
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

  if (result.status !== 0 && !options.allowFailure) {
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
    dryRun: false,
    otp: "",
    registry: DEFAULT_REGISTRY,
    tag: "latest",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--registry") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--registry requires a value.");
      }
      options.registry = value;
      index += 1;
      continue;
    }

    if (arg === "--otp") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--otp requires a value.");
      }
      options.otp = value;
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--tag requires a value.");
      }
      options.tag = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: npm run publish:dual -- [--dry-run] [--registry <url>] [--tag <tag>] [--otp <code>]",
      "",
      "Publishes cli-wechat-bridge as the primary package and @unlinearity/cli-wechat-bridge as a compatibility mirror.",
      "Existing package versions are skipped automatically.",
      "",
      "Options:",
      "  --dry-run         Run npm publish in dry-run mode for missing package versions",
      "  --registry <url>  npm registry URL, defaults to https://registry.npmjs.org/",
      "  --tag <tag>       npm dist-tag, defaults to latest",
      "  --otp <code>      Forward a one-time password to npm publish",
      "",
    ].join("\n"),
  );
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
}

function getPackageVersion(packageJson) {
  const version = packageJson.version;
  if (!version || typeof version !== "string") {
    throw new Error("package.json must define a string version.");
  }
  return version;
}

function isNotFoundResult(result) {
  const output = [
    typeof result.stdout === "string" ? result.stdout : "",
    typeof result.stderr === "string" ? result.stderr : "",
  ].join("\n");
  return output.includes("E404") || output.includes("404 Not Found");
}

function readPublishedVersion(packageName, version, registry) {
  const result = runNpm(
    [
      "view",
      `${packageName}@${version}`,
      "version",
      "--registry",
      registry,
      "--json",
    ],
    { allowFailure: true },
  );

  if (result.status === 0) {
    return result.stdout.trim().replace(/^"|"$/g, "") || version;
  }

  if (isNotFoundResult(result)) {
    return null;
  }

  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  throw new Error(`Unable to check ${packageName}@${version}: ${stderr}`);
}

function copyMirrorFile(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Required mirror file is missing: ${sourcePath}`);
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function createMirrorPackage(packageJson) {
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-wechat-bridge-mirror-"));

  for (const fileName of MIRROR_FILES) {
    copyMirrorFile(path.join(REPO_ROOT, fileName), path.join(mirrorRoot, fileName));
  }

  const mirrorPackageJson = {
    ...packageJson,
    name: COMPAT_PACKAGE_NAME,
    scripts: undefined,
    devDependencies: undefined,
    publishConfig: {
      access: "public",
    },
  };

  // Drop dev scripts, but keep postinstall: it restores the node-pty
  // spawn-helper execute bit (upstream tarballs ship 0644), and without it
  // PTY-based adapters fail on macOS/Linux installs of the mirror package.
  const postinstallScript = packageJson.scripts?.postinstall;
  delete mirrorPackageJson.scripts;
  delete mirrorPackageJson.devDependencies;
  if (postinstallScript) {
    mirrorPackageJson.scripts = { postinstall: postinstallScript };
  }

  fs.writeFileSync(
    path.join(mirrorRoot, "package.json"),
    `${JSON.stringify(mirrorPackageJson, null, 2)}\n`,
    "utf8",
  );

  return mirrorRoot;
}

function publishFromCwd(packageName, version, cwd, options) {
  const publishedVersion = readPublishedVersion(packageName, version, options.registry);
  if (publishedVersion) {
    log(`${packageName}@${publishedVersion} already exists; skipping.`);
    return "skipped";
  }

  const args = [
    "publish",
    "--access",
    "public",
    "--tag",
    options.tag,
    "--registry",
    options.registry,
  ];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.otp) {
    args.push("--otp", options.otp);
  }

  log(`${options.dryRun ? "Dry-running" : "Publishing"} ${packageName}@${version}...`);
  runNpm(args, { cwd, stdio: "inherit" });
  return "published";
}

function removePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = readPackageJson();
  const version = getPackageVersion(packageJson);

  if (packageJson.name !== PRIMARY_PACKAGE_NAME) {
    throw new Error(
      `package.json name must be ${PRIMARY_PACKAGE_NAME} before dual publishing; found ${packageJson.name}.`,
    );
  }

  const primaryPublished = readPublishedVersion(
    PRIMARY_PACKAGE_NAME,
    version,
    options.registry,
  );
  const compatPublished = readPublishedVersion(
    COMPAT_PACKAGE_NAME,
    version,
    options.registry,
  );

  if (primaryPublished && compatPublished) {
    log(`Both package versions already exist for ${version}; nothing to publish.`);
    return;
  }

  log(`Building ${PRIMARY_PACKAGE_NAME}@${version} once before publishing both packages...`);
  runNpm(["run", "build"], { stdio: "inherit" });

  publishFromCwd(PRIMARY_PACKAGE_NAME, version, REPO_ROOT, options);

  let mirrorRoot = "";
  try {
    mirrorRoot = createMirrorPackage(packageJson);
    publishFromCwd(COMPAT_PACKAGE_NAME, version, mirrorRoot, options);
  } finally {
    removePath(mirrorRoot);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[publish-dual] ERROR: ${message}\n`);
  process.exit(1);
}
