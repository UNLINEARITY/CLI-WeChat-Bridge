import crypto from "node:crypto";
import fs from "node:fs";
import type net from "node:net";

import {
  ensureWorkspaceChannelDir,
  getWorkspaceAdapterEndpointFile,
  getWorkspaceChannelPaths,
} from "../wechat/channel-config.ts";
import type {
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeEvent,
  BridgeWorkerStatus,
} from "../bridge/bridge-types.ts";
import {
  LOCAL_CLIENT_PROTOCOL_VERSION,
  type LocalClientEndpoint,
} from "../runtime/runtime-types.ts";

export type LocalCompanionCommand =
  | { command: "send_input"; text: string }
  | { command: "list_resume_sessions"; limit?: number }
  | { command: "list_resume_threads"; limit?: number }
  | { command: "resume_session"; sessionId: string }
  | { command: "resume_thread"; threadId: string }
  | { command: "create_session" }
  | { command: "interrupt" }
  | { command: "reset" }
  | { command: "dispose" }
  | { command: "resolve_approval"; action: "confirm" | "deny" };

export type LocalCompanionCloseReason =
  | "bridge_dispose"
  | "companion_shutdown"
  | "fatal_error"
  | "signal"
  | "worker_exit";

export type LocalCompanionEndpoint = LocalClientEndpoint;

type EndpointReadOptions = {
  adapter?: BridgeAdapterKind;
};

type EndpointWriteOptions = {
  writeLegacy?: boolean;
};

export type LocalCompanionMessage =
  | {
      type: "hello";
      token: string;
      companionPid?: number;
      panelPid?: number;
    }
  | {
      type: "hello_ack";
    }
  | {
      type: "closing";
      reason: LocalCompanionCloseReason;
      exitCode?: number;
    }
  | {
      type: "request";
      id: string;
      payload: LocalCompanionCommand;
    }
  | {
      type: "response";
      id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: "event";
      event: BridgeEvent;
    }
  | {
      type: "state";
      state: BridgeAdapterState;
    };

function normalizeEndpoint(value: unknown): LocalCompanionEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "codex" ||
    record.kind === "claude" ||
    record.kind === "opencode" ||
    record.kind === "pi" ||
    record.kind === "shell"
      ? record.kind
      : "codex";
  const sharedSessionId =
    typeof record.sharedSessionId === "string"
      ? record.sharedSessionId
      : typeof record.sharedThreadId === "string"
        ? record.sharedThreadId
        : undefined;

  if (
    typeof record.instanceId !== "string" ||
    typeof record.port !== "number" ||
    typeof record.token !== "string" ||
    typeof record.cwd !== "string" ||
    typeof record.command !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return null;
  }

  return {
    protocolVersion:
      typeof record.protocolVersion === "number"
        ? record.protocolVersion
        : LOCAL_CLIENT_PROTOCOL_VERSION,
    runtimeKind:
      record.runtimeKind === "codex_runtime_host" ? "codex_runtime_host" : "legacy_adapter",
    instanceId: record.instanceId,
    kind,
    port: record.port,
    token: record.token,
    renderMode:
      record.renderMode === "embedded" ||
      record.renderMode === "panel" ||
      record.renderMode === "companion" ||
      record.renderMode === "headless"
        ? record.renderMode
        : undefined,
    bridgeOwnerPid:
      typeof record.bridgeOwnerPid === "number" ? record.bridgeOwnerPid : undefined,
    serverPort: typeof record.serverPort === "number" ? record.serverPort : undefined,
    serverUrl: typeof record.serverUrl === "string" ? record.serverUrl : undefined,
    remoteAuthTokenEnv:
      typeof record.remoteAuthTokenEnv === "string" ? record.remoteAuthTokenEnv : undefined,
    cwd: record.cwd,
    command: record.command,
    profile: typeof record.profile === "string" ? record.profile : undefined,
    sharedSessionId,
    sharedThreadId:
      kind === "codex" || kind === "opencode"
        ? sharedSessionId
        : typeof record.sharedThreadId === "string"
          ? record.sharedThreadId
          : undefined,
    resumeConversationId:
      typeof record.resumeConversationId === "string" ? record.resumeConversationId : undefined,
    transcriptPath:
      typeof record.transcriptPath === "string" ? record.transcriptPath : undefined,
    companionPid: typeof record.companionPid === "number" ? record.companionPid : undefined,
    companionConnectedAt:
      typeof record.companionConnectedAt === "string" ? record.companionConnectedAt : undefined,
    companionStatus:
      typeof record.companionStatus === "string"
        ? (record.companionStatus as BridgeWorkerStatus)
        : undefined,
    companionLastStateAt:
      typeof record.companionLastStateAt === "string" ? record.companionLastStateAt : undefined,
    companionWorkerPid:
      typeof record.companionWorkerPid === "number" ? record.companionWorkerPid : undefined,
    startedAt: record.startedAt,
  };
}

export function buildLocalCompanionToken(): string {
  return crypto.randomBytes(18).toString("hex");
}

function serializeEndpoint(endpoint: LocalCompanionEndpoint): LocalCompanionEndpoint {
  return {
    ...endpoint,
    protocolVersion: endpoint.protocolVersion ?? LOCAL_CLIENT_PROTOCOL_VERSION,
    sharedThreadId:
      endpoint.kind === "codex" || endpoint.kind === "opencode"
        ? endpoint.sharedSessionId ?? endpoint.sharedThreadId
        : undefined,
  };
}

function readEndpointFile(filePath: string): LocalCompanionEndpoint | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return normalizeEndpoint(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function writeLocalCompanionEndpoint(
  endpoint: LocalCompanionEndpoint,
  options: EndpointWriteOptions = {},
): void {
  const { endpointFile } = ensureWorkspaceChannelDir(endpoint.cwd);
  const payload: LocalCompanionEndpoint = {
    ...serializeEndpoint(endpoint),
  };

  fs.writeFileSync(
    getWorkspaceAdapterEndpointFile(endpoint.cwd, endpoint.kind),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  if (options.writeLegacy !== false) {
    fs.writeFileSync(endpointFile, JSON.stringify(payload, null, 2), "utf8");
  }
}

export function readLocalCompanionEndpoint(
  cwd: string,
  options: EndpointReadOptions = {},
): LocalCompanionEndpoint | null {
  try {
    const { endpointFile } = getWorkspaceChannelPaths(cwd);
    if (options.adapter) {
      const scoped = readEndpointFile(
        getWorkspaceAdapterEndpointFile(cwd, options.adapter),
      );
      if (scoped) {
        return scoped;
      }
      const legacy = readEndpointFile(endpointFile);
      return legacy?.kind === options.adapter ? legacy : null;
    }
    return readEndpointFile(endpointFile);
  } catch {
    return null;
  }
}

export function clearLocalCompanionEndpoint(
  cwd: string,
  instanceId?: string,
  options: EndpointReadOptions = {},
): void {
  try {
    const { endpointFile } = getWorkspaceChannelPaths(cwd);
    const files = options.adapter
      ? [getWorkspaceAdapterEndpointFile(cwd, options.adapter), endpointFile]
      : [
          endpointFile,
          getWorkspaceAdapterEndpointFile(cwd, "codex"),
          getWorkspaceAdapterEndpointFile(cwd, "claude"),
          getWorkspaceAdapterEndpointFile(cwd, "opencode"),
          getWorkspaceAdapterEndpointFile(cwd, "pi"),
          getWorkspaceAdapterEndpointFile(cwd, "shell"),
        ];

    for (const filePath of files) {
      if (!fs.existsSync(filePath)) {
        continue;
      }

      if (!instanceId) {
        fs.rmSync(filePath, { force: true });
        continue;
      }

      const endpoint = readEndpointFile(filePath);
      if (!endpoint || endpoint.instanceId === instanceId) {
        fs.rmSync(filePath, { force: true });
      }
    }
  } catch {
    // Best effort cleanup.
  }
}

export function clearLocalCompanionOccupancy(
  cwd: string,
  instanceId?: string,
  options: EndpointReadOptions = {},
): void {
  try {
    const endpoint = readLocalCompanionEndpoint(cwd, options);
    if (!endpoint) {
      return;
    }

    if (instanceId && endpoint.instanceId !== instanceId) {
      return;
    }

    writeLocalCompanionEndpoint({
      ...endpoint,
      companionPid: undefined,
      companionConnectedAt: undefined,
      companionStatus: undefined,
      companionLastStateAt: undefined,
      companionWorkerPid: undefined,
    });
  } catch {
    // Best effort cleanup.
  }
}

export function updateLocalCompanionHealth(
  cwd: string,
  patch: {
    companionStatus?: BridgeWorkerStatus;
    companionLastStateAt?: string;
    companionWorkerPid?: number;
  },
  instanceId?: string,
  options: EndpointReadOptions = {},
): void {
  try {
    const endpoint = readLocalCompanionEndpoint(cwd, options);
    if (!endpoint) {
      return;
    }

    if (instanceId && endpoint.instanceId !== instanceId) {
      return;
    }

    writeLocalCompanionEndpoint({
      ...endpoint,
      companionStatus: patch.companionStatus,
      companionLastStateAt: patch.companionLastStateAt,
      companionWorkerPid: patch.companionWorkerPid,
    });
  } catch {
    // Best effort cleanup.
  }
}

export function updateLocalCompanionOccupancy(
  cwd: string,
  patch: {
    companionPid?: number;
    companionConnectedAt?: string;
  },
  instanceId?: string,
  options: EndpointReadOptions = {},
): void {
  try {
    const endpoint = readLocalCompanionEndpoint(cwd, options);
    if (!endpoint) {
      return;
    }

    if (instanceId && endpoint.instanceId !== instanceId) {
      return;
    }

    writeLocalCompanionEndpoint({
      ...endpoint,
      companionPid: patch.companionPid,
      companionConnectedAt: patch.companionConnectedAt,
    });
  } catch {
    // Best effort cleanup.
  }
}

export function sendLocalCompanionMessage(
  socket: net.Socket,
  message: LocalCompanionMessage,
): boolean {
  if (socket.destroyed || socket.writableEnded) {
    return false;
  }

  try {
    return socket.write(`${JSON.stringify(message)}\n`);
  } catch {
    return false;
  }
}

const MAX_IPC_BUFFER_SIZE = 1_048_576; // 1MB

export function attachLocalCompanionMessageListener(
  socket: net.Socket,
  onMessage: (message: LocalCompanionMessage) => void,
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
        onMessage(JSON.parse(line) as LocalCompanionMessage);
      } catch {
        // Ignore malformed local IPC frames.
      }
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", onData);
  return () => {
    socket.off("data", onData);
  };
}
