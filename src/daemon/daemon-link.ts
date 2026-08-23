import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import {
  DAEMON_ENDPOINT_FILE,
  ensureChannelDataDir,
} from "../wechat/channel-config.ts";
import type { BridgeSessionStartMode } from "../bridge/bridge-types.ts";

export const DAEMON_PROTOCOL_VERSION = 1;
export type DaemonAdapterKind = "codex" | "claude" | "opencode" | "pi";

export type DaemonEndpoint = {
  protocolVersion: number;
  pid: number;
  port: number;
  token: string;
  cwd: string;
  startedAt: string;
};

export type DaemonSlotSummary = {
  adapter: DaemonAdapterKind;
  status: string;
  cwd: string;
  companionPid?: number;
  pendingApproval: boolean;
  pendingUserInput: boolean;
};

export type DaemonStatus = {
  cwd: string;
  activeAdapter?: DaemonAdapterKind;
  startedAt: string;
  slots: DaemonSlotSummary[];
};

export type DaemonRequest =
  | {
      command: "ensure_slot";
      adapter: DaemonAdapterKind;
      cwd: string;
      profile?: string;
      cliArgs?: string[];
      openVisible?: boolean;
      sessionStartMode?: BridgeSessionStartMode;
      reuseExistingVisible?: boolean;
    }
  | {
      command: "switch_adapter";
      adapter: DaemonAdapterKind;
      profile?: string;
      cliArgs?: string[];
      openVisible?: boolean;
      sessionStartMode?: BridgeSessionStartMode;
      reuseExistingVisible?: boolean;
    }
  | { command: "status" }
  | { command: "shutdown" };

export type DaemonResponse =
  | {
      ok: true;
      result?: unknown;
    }
  | {
      ok: false;
      error: string;
    };

type DaemonIpcRequestFrame = {
  id: string;
  token: string;
  payload: DaemonRequest;
};

type DaemonIpcResponseFrame = {
  id: string;
  response: DaemonResponse;
};

function normalizeDaemonEndpoint(value: unknown): DaemonEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.protocolVersion !== "number" ||
    typeof record.pid !== "number" ||
    typeof record.port !== "number" ||
    typeof record.token !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return null;
  }

  return {
    protocolVersion: record.protocolVersion,
    pid: record.pid,
    port: record.port,
    token: record.token,
    cwd: record.cwd,
    startedAt: record.startedAt,
  };
}

export function buildDaemonToken(): string {
  return crypto.randomBytes(18).toString("hex");
}

export function writeDaemonEndpoint(endpoint: DaemonEndpoint): void {
  ensureChannelDataDir();
  fs.writeFileSync(
    DAEMON_ENDPOINT_FILE,
    JSON.stringify(
      {
        ...endpoint,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function readDaemonEndpoint(): DaemonEndpoint | null {
  try {
    if (!fs.existsSync(DAEMON_ENDPOINT_FILE)) {
      return null;
    }
    return normalizeDaemonEndpoint(
      JSON.parse(fs.readFileSync(DAEMON_ENDPOINT_FILE, "utf8")),
    );
  } catch {
    return null;
  }
}

export function clearDaemonEndpoint(pid = process.pid): void {
  try {
    const endpoint = readDaemonEndpoint();
    if (!endpoint || endpoint.pid === pid) {
      fs.rmSync(DAEMON_ENDPOINT_FILE, { force: true });
    }
  } catch {
    // Best effort cleanup.
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the OS found the pid but denied access (e.g. a Windows
    // process running under another privilege level). The process exists, so
    // it must be treated as alive — returning false here would let callers
    // delete a live daemon's endpoint file and break its singleton.
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sendDaemonResponse(
  socket: net.Socket,
  id: string,
  response: DaemonResponse,
): boolean {
  if (socket.destroyed || socket.writableEnded) {
    return false;
  }

  try {
    return socket.write(`${JSON.stringify({ id, response })}\n`);
  } catch {
    return false;
  }
}

const MAX_IPC_BUFFER_SIZE = 1_048_576; // 1MB

export function attachDaemonRequestListener(
  socket: net.Socket,
  onRequest: (frame: DaemonIpcRequestFrame) => void,
): () => void {
  let buffer = "";
  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (buffer.length > MAX_IPC_BUFFER_SIZE) {
      socket.destroy(new Error("IPC buffer overflow: exceeded 1MB without complete frame"));
      buffer = "";
      return;
    }

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      try {
        onRequest(JSON.parse(line) as DaemonIpcRequestFrame);
      } catch {
        // Ignore malformed daemon IPC frames.
      }
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", onData);
  return () => {
    socket.off("data", onData);
  };
}

export async function sendDaemonRequest(
  endpoint: DaemonEndpoint,
  payload: DaemonRequest,
  options: { timeoutMs?: number } = {},
): Promise<DaemonResponse> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const id = crypto.randomUUID();

  return await new Promise<DaemonResponse>((resolve) => {
    const socket = net.connect({
      host: "127.0.0.1",
      port: endpoint.port,
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish({ ok: false, error: "Timed out waiting for daemon response." });
    }, timeoutMs);

    const finish = (response: DaemonResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id,
          token: endpoint.token,
          payload,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        try {
          const frame = JSON.parse(line) as DaemonIpcResponseFrame;
          if (frame.id === id) {
            finish(frame.response);
          }
        } catch {
          // Ignore malformed daemon IPC frames.
        }
      }
    });
    socket.once("error", () => {
      finish({ ok: false, error: "Daemon endpoint is not reachable." });
    });
  });
}

export async function isDaemonEndpointAlive(
  endpoint: DaemonEndpoint,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!isPidAlive(endpoint.pid)) {
    return false;
  }

  const response = await sendDaemonRequest(endpoint, { command: "status" }, options);
  return response.ok;
}
