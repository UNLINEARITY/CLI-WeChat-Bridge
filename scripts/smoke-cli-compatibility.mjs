#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const COMMAND_TIMEOUT_MS = 30_000;
const SERVER_TIMEOUT_MS = 30_000;

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not expose expected capability: ${expected}`);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local OpenCode smoke-test port.");
  }
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function waitForHealth(url, child, headers = undefined) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  let lastError = "server did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode exited before health check (${child.exitCode}).`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for OpenCode health endpoint: ${lastError}`);
}

async function smokeOpenCode(majorVersion) {
  const port = await reservePort();
  const serveArgs = ["serve"];
  if (majorVersion < 2) {
    serveArgs.push("--pure");
  }
  serveArgs.push("--hostname", "127.0.0.1", "--port", String(port));
  const password = majorVersion >= 2 ? "cli-bridge-compat" : undefined;
  const child = spawn(
    "opencode",
    serveArgs,
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    const healthPath = majorVersion >= 2 ? "/api/info" : "/global/health";
    const headers = password
      ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}` }
      : undefined;
    await waitForHealth(`http://127.0.0.1:${port}${healthPath}`, child, headers);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-bridge-compat-"));
  try {
    const codexVersion = run("codex", ["--version"]).trim();
    const codexHelp = run("codex", ["app-server", "generate-json-schema", "--help"]);
    assertIncludes(codexHelp, "--out", "Codex app-server schema generator");
    const schemaDir = path.join(tempDir, "codex-schema");
    run("codex", ["app-server", "generate-json-schema", "--out", schemaDir]);
    if (!fs.existsSync(schemaDir) || fs.readdirSync(schemaDir).length === 0) {
      throw new Error("Codex app-server schema generator produced no files.");
    }

    const claudeVersion = run("claude", ["--version"]).trim();
    const claudeHelp = run("claude", ["--help"]);
    assertIncludes(claudeHelp, "--settings", "Claude Code");

    const openCodeVersion = run("opencode", ["--version"]).trim();
    const openCodeVersionMatch = /\bv?(\d+)\.\d+\.\d+\b/.exec(openCodeVersion);
    if (!openCodeVersionMatch) {
      throw new Error(`Could not parse OpenCode version: ${openCodeVersion}`);
    }
    const openCodeMajor = Number(openCodeVersionMatch[1]);
    const openCodeHelp = run("opencode", ["serve", "--help"]);
    assertIncludes(
      openCodeHelp,
      openCodeMajor >= 2 ? "--stdio" : "--pure",
      "OpenCode server",
    );
    await smokeOpenCode(openCodeMajor);

    const piVersion = run("pi", ["--version"]).trim();
    const piHelp = run("pi", ["--help"]);
    assertIncludes(piHelp, "--extension", "Pi");
    assertIncludes(piHelp, "--list-models", "Pi");

    console.log(`Codex: ${codexVersion}`);
    console.log(`Claude Code: ${claudeVersion}`);
    console.log(`OpenCode: ${openCodeVersion}`);
    console.log(`Pi: ${piVersion}`);
    console.log("CLI compatibility smoke passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
