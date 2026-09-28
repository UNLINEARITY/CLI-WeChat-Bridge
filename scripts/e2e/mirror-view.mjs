#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to its users.
//
// View-only mirror for the e2e PTY host. Connects to the visible-host control
// socket, asks for a replay of recent output, then renders the live TUI byte
// stream raw so a real terminal window shows the same screen as the PTY.
//
// Usage: node mirror-view.mjs <control-socket-path>

import net from "node:net";

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("Usage: node mirror-view.mjs <control-socket-path>");
  process.exit(1);
}

// Best-effort: size the hosting terminal window to the PTY dimensions so the
// mirrored TUI renders without wrapping (CSI 8 ; rows ; cols t).
process.stdout.write("\u001b[8;40;120t");

const socket = net.createConnection(socketPath);
socket.setNoDelay(true);

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ type: "mirror" })}\n`);
});

socket.on("data", (chunk) => {
  let buffer = chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      newline = buffer.indexOf("\n");
      continue;
    }
    try {
      const message = JSON.parse(line);
      if (message.type === "output" && typeof message.data === "string") {
        process.stdout.write(message.data);
      }
    } catch {
      // Ignore malformed frames.
    }
    newline = buffer.indexOf("\n");
  }
});

socket.on("close", () => {
  process.stdout.write("\r\n[mirror] PTY host closed. This window can be closed.\r\n");
  process.exit(0);
});

socket.on("error", (error) => {
  console.error(`[mirror] connection error: ${error.message}`);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
