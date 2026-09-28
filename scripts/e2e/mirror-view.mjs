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

// The mirrored TUI enables mouse tracking; a real terminal would then turn
// mouse motion and scrolling into SGR reports on stdin. Swallow stdin in raw
// mode (this is a view-only mirror) so the reports are never echoed back as
// visible garbage, and let Ctrl+C close the window.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\u0003")) {
    process.exit(0);
  }
});

// Mouse-mode enable/disable sequences must not leak into the hosting window:
// they would put it into mouse tracking (breaking text selection) while the
// reports have nowhere to go. Everything else is forwarded verbatim.
const MOUSE_MODE_PATTERN = /\u001b\[\?(?:1000|1002|1003|1006|1016)(?:[hl])\b/g;

function writeMirror(data) {
  process.stdout.write(data.replace(MOUSE_MODE_PATTERN, ""));
}

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
        writeMirror(message.data);
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
