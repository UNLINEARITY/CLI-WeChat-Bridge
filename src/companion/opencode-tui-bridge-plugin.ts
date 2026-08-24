import net from "node:net";

type TuiRoute = {
  name?: string;
  params?: Record<string, unknown>;
  type?: string;
  sessionID?: string;
};

type OpenCodeTuiPluginApi = {
  route: {
    readonly current: TuiRoute;
  };
  lifecycle: {
    onDispose(callback: () => void): void;
  };
};

type OpenCodeTuiPluginOptions = {
  port?: unknown;
  token?: unknown;
};

const ROUTE_POLL_INTERVAL_MS = 100;
const MAX_BUFFER_SIZE = 1024 * 1024;

function extractSessionId(route: TuiRoute): string | null {
  if (route.name === "session" && typeof route.params?.sessionID === "string") {
    return route.params.sessionID;
  }
  if (route.type === "session" && typeof route.sessionID === "string") {
    return route.sessionID;
  }
  return null;
}

export default {
  id: "cli-wechat-bridge.session-route",
  tui: async (
    api: OpenCodeTuiPluginApi,
    options: OpenCodeTuiPluginOptions | undefined,
  ): Promise<void> => {
    const port = Number(options?.port);
    const token = typeof options?.token === "string" ? options.token : "";
    if (!Number.isInteger(port) || port <= 0 || !token) {
      return;
    }

    const socket = net.connect({ host: "127.0.0.1", port });
    let connected = false;
    let lastSessionId: string | null | undefined;
    let queuedFrame: Record<string, unknown> | null = null;

    const writeFrame = (frame: Record<string, unknown>) => {
      if (socket.destroyed) {
        return;
      }
      if (!connected) {
        queuedFrame = frame;
        return;
      }
      socket.write(`${JSON.stringify(frame)}\n`);
    };

    const publishRoute = () => {
      const sessionId = extractSessionId(api.route.current);
      if (sessionId === lastSessionId) {
        return;
      }
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
      if (chunk.length > MAX_BUFFER_SIZE) {
        socket.destroy();
      }
    });
    socket.on("error", () => {
      // Keep the native TUI usable if the bridge-side observer disappears.
    });

    const timer = setInterval(publishRoute, ROUTE_POLL_INTERVAL_MS);
    timer.unref?.();
    api.lifecycle.onDispose(() => {
      clearInterval(timer);
      socket.destroy();
    });
  },
};
