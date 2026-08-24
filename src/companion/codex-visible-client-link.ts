import crypto from "node:crypto";
import net from "node:net";

import {
  readLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "./local-companion-link.ts";

export const CODEX_VISIBLE_CONTROL_HOST = "127.0.0.1";
export const CODEX_VISIBLE_SWITCH_TIMEOUT_MS = 15_000;

export type CodexVisibleSwitchRequest = {
  type: "switch_thread";
  id: string;
  token: string;
  threadId: string;
};

export type CodexVisibleSwitchResponse = {
  type: "switch_thread_result";
  id: string;
  ok: boolean;
  threadId?: string;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCodexVisibleSwitchRequest(
  value: unknown,
): CodexVisibleSwitchRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.type !== "switch_thread" ||
    typeof value.id !== "string" ||
    typeof value.token !== "string" ||
    typeof value.threadId !== "string"
  ) {
    return null;
  }
  return {
    type: "switch_thread",
    id: value.id,
    token: value.token,
    threadId: value.threadId,
  };
}

export function sendCodexVisibleSwitchResponse(
  socket: net.Socket,
  response: CodexVisibleSwitchResponse,
): void {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }
  socket.end(`${JSON.stringify(response)}\n`);
}

function resolveCodexControlEndpoint(
  cwd: string,
  instanceId: string,
): LocalCompanionEndpoint {
  const endpoint = readLocalCompanionEndpoint(cwd, { adapter: "codex" });
  if (!endpoint || endpoint.kind !== "codex" || endpoint.instanceId !== instanceId) {
    throw new Error(`The visible Codex client for ${cwd} is no longer attached to this runtime.`);
  }
  if (!endpoint.codexControlPort || !endpoint.codexControlToken) {
    throw new Error(
      'The visible Codex client does not support remote thread switching. Close it and run "wechat-codex" again.',
    );
  }
  return endpoint;
}

export async function requestCodexVisibleThreadSwitch(params: {
  cwd: string;
  instanceId: string;
  threadId: string;
  timeoutMs?: number;
}): Promise<string> {
  const endpoint = resolveCodexControlEndpoint(params.cwd, params.instanceId);
  const requestId = crypto.randomUUID();
  const timeoutMs = params.timeoutMs ?? CODEX_VISIBLE_SWITCH_TIMEOUT_MS;

  return await new Promise<string>((resolve, reject) => {
    const socket = net.connect({
      host: CODEX_VISIBLE_CONTROL_HOST,
      port: endpoint.codexControlPort!,
    });
    let buffer = "";
    let settled = false;

    const finish = (error?: Error, threadId?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(threadId ?? params.threadId);
      }
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const request: CodexVisibleSwitchRequest = {
        type: "switch_thread",
        id: requestId,
        token: endpoint.codexControlToken!,
        threadId: params.threadId,
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 65_536) {
        finish(new Error("The visible Codex client returned an oversized control response."));
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(new Error("The visible Codex client returned an invalid control response."));
        return;
      }
      if (!isRecord(parsed) || parsed.type !== "switch_thread_result" || parsed.id !== requestId) {
        finish(new Error("The visible Codex client returned an unexpected control response."));
        return;
      }
      if (parsed.ok !== true) {
        finish(
          new Error(
            typeof parsed.error === "string"
              ? parsed.error
              : "The visible Codex client could not switch threads.",
          ),
        );
        return;
      }
      if (parsed.threadId !== params.threadId) {
        finish(
          new Error(
            `The visible Codex client opened ${String(parsed.threadId)}, expected ${params.threadId}.`,
          ),
        );
        return;
      }
      finish(undefined, parsed.threadId);
    });
    socket.once("timeout", () => {
      finish(new Error(`Timed out waiting for the visible Codex client to open ${params.threadId}.`));
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) {
        finish(new Error("The visible Codex client closed the control connection."));
      }
    });
  });
}
