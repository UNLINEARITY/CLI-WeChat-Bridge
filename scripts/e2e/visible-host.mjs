#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to its users.
//
// E2E visible-client host. The daemon spawns this script (via the
// CLI_BRIDGE_VISIBLE_LAUNCHER override) with the exact argv it would have run
// inside a terminal window. This host runs that command inside a node-pty and
// exposes the PTY over a local control socket so the e2e runner can type and
// read the visible CLI just like a local user.
//
// Usage (spawned by the daemon, not run directly):
//   node visible-host.mjs <node-flags...> <entry> <entry-args...>
//
// Environment:
//   CLI_BRIDGE_E2E_CONTROL_DIR  directory for <adapter>.sock and output logs

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import pty from "node-pty";

const argv = process.argv.slice(2);

function detectAdapter(list) {
  const index = list.indexOf("--adapter");
  if (index >= 0 && list[index + 1]) {
    return list[index + 1];
  }
  const entry = list.find((arg) => /codex-remote-client(\.\w+)?$/.test(arg));
  return entry ? "codex" : "unknown";
}

function log(message) {
  process.stderr.write(`[e2e-visible-host] ${message}\n`);
}

const controlDir = process.env.CLI_BRIDGE_E2E_CONTROL_DIR;
if (!controlDir) {
  log("CLI_BRIDGE_E2E_CONTROL_DIR is not set; refusing to start.");
  process.exit(1);
}
const adapter = detectAdapter(argv);
if (adapter === "unknown") {
  log(`Could not detect the adapter from argv: ${JSON.stringify(argv)}`);
  process.exit(1);
}

fs.mkdirSync(controlDir, { recursive: true });
const socketPath = path.join(controlDir, `${adapter}.sock`);
const outputLogPath = path.join(controlDir, `${adapter}.output.log`);
try {
  fs.rmSync(socketPath, { force: true });
} catch {
  // Best effort cleanup.
}

const clients = new Set();
const server = net.createServer((socket) => {
  clients.add(socket);
  socket.setNoDelay(true);
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        handleCommand(line, socket);
      }
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => {
    clients.delete(socket);
    socket.destroy();
  });
  send(socket, { type: "hello", adapter, entry: argv.join(" ") });
});

function send(socket, message) {
  try {
    socket.write(`${JSON.stringify(message)}\n`);
  } catch {
    // The control client may have disconnected between events.
  }
}

function broadcast(message) {
  for (const socket of clients) {
    send(socket, message);
  }
}

function handleCommand(line, socket) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send(socket, { type: "error", error: "invalid json" });
    return;
  }
  if (message.type === "ping") {
    send(socket, { type: "pong" });
    return;
  }
  if (message.type === "mirror") {
    // Replay the recent PTY byte stream so a freshly opened mirror window
    // renders the current screen, then continue with live frames.
    try {
      const stat = fs.statSync(outputLogPath);
      const length = Math.min(stat.size, 256 * 1024);
      const fd = fs.openSync(outputLogPath, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      fs.closeSync(fd);
      send(socket, { type: "output", data: buffer.toString("utf8") });
    } catch {
      // No output yet; live frames will follow.
    }
    return;
  }
  if (message.type === "write" && typeof message.data === "string") {
    child.write(message.data);
    return;
  }
  if (message.type === "resize" && Number.isSafeInteger(message.cols) && Number.isSafeInteger(message.rows)) {
    child.resize(message.cols, message.rows);
    return;
  }
  if (message.type === "kill") {
    child.kill();
    return;
  }
  send(socket, { type: "error", error: `unknown message: ${line.slice(0, 120)}` });
}

server.listen(socketPath, () => {
  log(`control socket ready: ${socketPath}`);
});

const child = pty.spawn(process.execPath, argv, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.env.CLI_BRIDGE_E2E_WORKSPACE || process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
});

fs.appendFileSync(outputLogPath, `[${new Date().toISOString()}] started pid=${child.pid} argv=${JSON.stringify(argv)}\n`, "utf8");
broadcast({ type: "started", pid: child.pid, adapter });
log(`spawned pid=${child.pid}: ${argv.join(" ")}`);

child.onData((data) => {
  fs.appendFileSync(outputLogPath, data, "utf8");
  broadcast({ type: "output", data });
});

child.onExit(({ exitCode }) => {
  broadcast({ type: "exit", code: exitCode });
  log(`child exited with code ${exitCode}`);
  for (const socket of clients) {
    socket.destroy();
  }
  server.close(() => {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1_000).unref();
});

process.on("SIGTERM", () => {
  child.kill();
});
process.on("SIGINT", () => {
  child.kill();
});
