import type {
  BridgeAdapterKind,
  BridgeAdapterState,
} from "./bridge-types.ts";

export type CodexRpcRequestId = string | number;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getCodexRpcRequestId(value: unknown): CodexRpcRequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function getNotificationThreadId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (typeof params.threadId === "string") {
    return params.threadId;
  }

  if (isRecord(params.thread) && typeof params.thread.id === "string") {
    return params.thread.id;
  }

  return null;
}

export function getNotificationTurnId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (typeof params.turnId === "string") {
    return params.turnId;
  }

  if (isRecord(params.turn) && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return null;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function normalizeCodexRpcError(error: unknown): string {
  if (isRecord(error)) {
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.code === "number"
          ? `RPC error ${error.code}`
          : "";
    const data =
      typeof error.data === "string"
        ? error.data
        : typeof error.details === "string"
          ? error.details
          : "";
    const combined = [message, data].filter(Boolean).join(": ");
    if (combined) {
      return combined;
    }
  }

  return describeUnknownError(error);
}

export function getLocalCompanionCommandName(kind: BridgeAdapterKind): string {
  switch (kind) {
    case "codex":
      return "wechat-codex";
    case "claude":
      return "wechat-claude";
    case "opencode":
      return "wechat-opencode";
    default:
      return "local companion";
  }
}

export function getSharedSessionIdFromAdapterState(state: BridgeAdapterState): string | undefined {
  return state.sharedSessionId ?? state.sharedThreadId;
}

export function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function quotePosixCommandArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isRecentIsoTimestamp(timestamp: string, maxAgeMs: number): boolean {
  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) {
    return false;
  }
  return parsedMs >= Date.now() - maxAgeMs;
}

export function coerceWebSocketMessageData(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return null;
}
