#!/usr/bin/env node

import crypto from "node:crypto";
import net from "node:net";

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const portText = process.env.CLAUDE_WECHAT_HOOK_PORT;
  const token = process.env.CLAUDE_WECHAT_HOOK_TOKEN;
  const port = portText ? Number.parseInt(portText, 10) : Number.NaN;

  if (!token || !Number.isInteger(port) || port <= 0) {
    return;
  }

  const payload = await readStdin();
  if (!payload.trim()) {
    return;
  }
  const requestId = crypto.randomUUID();
  let stdout = "";

  await new Promise<void>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    const finish = () => {
      clearTimeout(connectTimer);
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
      resolve();
    };

    // Bail out if the bridge hook server never accepts the connection, so a
    // wedged bridge cannot leave Claude CLI blocked on this hook forever.
    // Once connected, we wait indefinitely: approval responses legitimately
    // take as long as the user needs to reply on WeChat.
    const connectTimer = setTimeout(finish, 10_000);

    socket.once("connect", () => {
      clearTimeout(connectTimer);
      try {
        socket.write(`${JSON.stringify({ token, requestId, payload })}\n`);
      } catch {
        finish();
      }
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        try {
          const response = JSON.parse(line) as {
            requestId?: string;
            stdout?: string;
          };
          if (response.requestId === requestId && typeof response.stdout === "string") {
            stdout = response.stdout;
          }
        } catch {
          // Ignore malformed hook responses.
        }
      }
    });
    socket.once("close", finish);
    socket.once("error", finish);
  });

  if (stdout) {
    process.stdout.write(stdout);
  }
}

main().catch(() => {
  process.exit(0);
});
