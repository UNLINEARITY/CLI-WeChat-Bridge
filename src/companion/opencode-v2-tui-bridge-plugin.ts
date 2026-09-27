// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import net from "node:net";

type TuiRoute =
  | { type: "home" }
  | { type: "session"; sessionID: string }
  | Record<string, unknown>;

type OpenCodeV2TuiContext = {
  options: Record<string, unknown>;
  ui: {
    router: {
      current(): TuiRoute;
      navigate(destination: { type: "session"; sessionID: string }): void;
    };
  };
};

const ROUTE_POLL_INTERVAL_MS = 100;
const MAX_BUFFER_SIZE = 1024 * 1024;

export default {
  id: "cli-wechat-bridge.session-route-v2",
  setup(context: OpenCodeV2TuiContext): () => void {
    const port = Number(context.options.port);
    const token = typeof context.options.token === "string" ? context.options.token : "";
    if (!Number.isInteger(port) || port <= 0 || !token) {
      return () => undefined;
    }

    const socket = net.connect({ host: "127.0.0.1", port });
    let connected = false;
    let inputBuffer = "";
    let lastSessionId: string | null | undefined;
    let queuedFrame: Record<string, unknown> | null = null;

    const writeFrame = (frame: Record<string, unknown>) => {
      if (socket.destroyed) return;
      if (!connected) {
        queuedFrame = frame;
        return;
      }
      socket.write(`${JSON.stringify(frame)}\n`);
    };

    const publishRoute = () => {
      const route = context.ui.router.current();
      const sessionId =
        route.type === "session" && typeof route.sessionID === "string"
          ? route.sessionID
          : null;
      if (sessionId === lastSessionId) return;
      lastSessionId = sessionId;
      writeFrame({
        type: "route_state",
        sessionId,
        observedAt: new Date().toISOString(),
      });
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.setNoDelay(true);
      socket.write(`${JSON.stringify({ type: "hello", token })}\n`);
      connected = true;
      publishRoute();
      if (queuedFrame) {
        socket.write(`${JSON.stringify(queuedFrame)}\n`);
        queuedFrame = null;
      }
    });
    socket.on("data", (chunk: string) => {
      inputBuffer += chunk;
      if (inputBuffer.length > MAX_BUFFER_SIZE) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = inputBuffer.slice(0, newline).trim();
        inputBuffer = inputBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "select_session" && typeof frame.sessionId === "string") {
            context.ui.router.navigate({ type: "session", sessionID: frame.sessionId });
            publishRoute();
          }
        } catch {
          // Ignore malformed bridge frames and keep the visible TUI alive.
        }
      }
    });
    socket.on("error", () => {
      // Keep the native TUI usable if the bridge-side observer disappears.
    });

    const timer = setInterval(publishRoute, ROUTE_POLL_INTERVAL_MS);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      socket.destroy();
    };
  },
};
