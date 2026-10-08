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
import { fileURLToPath } from "node:url";

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

export async function waitForHealth(url, child, headers = undefined, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? SERVER_TIMEOUT_MS);
  let lastError = "server did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode != null) {
      throw new Error(`OpenCode exited before health check (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      // The TCP listener can accept a request before OpenCode's HTTP layer is
      // ready. Bound each attempt, including the response body, so that race
      // retries instead of hanging until undici's five-minute headers timeout.
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(Math.max(1, Math.min(
          options.probeTimeoutMs ?? 3_000,
          deadline - Date.now(),
        ))),
      });
      if (response.ok) {
        const health = await response.json();
        if (typeof health?.version === "string" &&
            (new URL(url).pathname === "/api/info" || health.healthy === true)) {
          return;
        }
        lastError = "invalid health response";
      } else {
        await response.body?.cancel();
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(
      options.retryIntervalMs ?? 250,
      deadline - Date.now(),
    ))));
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

async function smokePi(tempDir) {
  const sockets = new Set();
  let resolveProbe;
  let rejectProbe;
  const probe = new Promise((resolve, reject) => {
    resolveProbe = resolve;
    rejectProbe = reject;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.type === "session_state") {
            if (typeof frame.sessionId !== "string" || !frame.sessionId) {
              throw new Error("Pi extension returned no session id.");
            }
            socket.write(`${JSON.stringify({ id: "compat-models", type: "list_models" })}\n`);
          } else if (frame.id === "compat-models") {
            if (frame.success !== true || !Array.isArray(frame.data?.models)) {
              throw new Error(`Pi extension model probe failed: ${JSON.stringify(frame)}`);
            }
            resolveProbe();
          }
        } catch (error) {
          rejectProbe(error);
        }
      }
    });
    socket.on("error", rejectProbe);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const extensionPath = fileURLToPath(new URL("../src/companion/pi-tui-bridge-extension.ts", import.meta.url));
  const child = spawn("pi", [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--extension", extensionPath,
  ], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(tempDir, "pi"),
      CLI_BRIDGE_PI_TUI_PORT: String(server.address().port),
      CLI_BRIDGE_PI_TUI_TOKEN: "cli-bridge-compat",
    },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output += chunk.toString(); });
  }
  child.once("error", rejectProbe);
  child.once("exit", (code, signal) => rejectProbe(new Error(`Pi exited before extension probe (${code ?? signal}).`)));
  const timer = setTimeout(() => rejectProbe(new Error("Pi bridge extension probe timed out.")), COMMAND_TIMEOUT_MS);
  try {
    await probe;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

export function assertCodexSchemaCapabilities(schemaDir) {
  const contracts = {
    "v2/ThreadStartParams.json": ["cwd", "approvalPolicy", "approvalsReviewer", "sandbox"],
    "v2/ThreadResumeParams.json": ["threadId"],
    "v2/TurnStartParams.json": ["threadId", "input"],
    "v2/TurnCompletedNotification.json": ["threadId", "turn"],
    "ToolRequestUserInputParams.json": ["threadId", "turnId", "questions", "isBlocking"],
    "ToolRequestUserInputResponse.json": ["answers"],
    "PermissionsRequestApprovalParams.json": ["threadId", "turnId", "permissions"],
  };
  for (const [file, fields] of Object.entries(contracts)) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
    for (const field of fields) {
      if (!Object.hasOwn(schema.properties ?? {}, field)) {
        throw new Error(`Codex protocol ${file} is missing bridge field: ${field}`);
      }
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
    assertCodexSchemaCapabilities(schemaDir);
    assertIncludes(run("codex", ["--help"]), "--remote", "Codex visible client");
    console.log(`Codex: ${codexVersion} (bridge protocol checked)`);

    const claudeVersion = run("claude", ["--version"]).trim();
    const claudeHelp = run("claude", ["--help"]);
    assertIncludes(claudeHelp, "--settings", "Claude Code");
    assertIncludes(claudeHelp, "--resume", "Claude Code");
    console.log(`Claude Code: ${claudeVersion}`);

    const openCodeVersion = run("opencode", ["--version"]).trim();
    const openCodeVersionMatch = /\bv?(\d+)\.\d+\.\d+\b/.exec(openCodeVersion);
    if (!openCodeVersionMatch) {
      throw new Error(`Could not parse OpenCode version: ${openCodeVersion}`);
    }
    const openCodeMajor = Number(openCodeVersionMatch[1]);
    console.log(`OpenCode: ${openCodeVersion}`);
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
    await smokePi(tempDir);

    console.log(`Pi: ${piVersion} (bridge extension loaded and model IPC checked)`);
    console.log("CLI compatibility smoke passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
