#!/usr/bin/env bun

import net from "node:net";
import path from "node:path";

import { createBridgeAdapter } from "../bridge/bridge-adapters.ts";
import type { BridgeSessionStartMode } from "../bridge/bridge-types.ts";
import {
  LOCAL_COMPANION_RECONNECT_GRACE_MS,
} from "../bridge/bridge-adapters.shared.ts";
import { runCodexRemoteClientFromEndpoint } from "./codex-remote-client.ts";
import {
  attachLocalCompanionMessageListener,
  readLocalCompanionEndpoint,
  sendLocalCompanionMessage,
  type LocalCompanionCloseReason,
  type LocalCompanionEndpoint,
  type LocalCompanionMessage,
} from "./local-companion-link.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";

export const LOCAL_COMPANION_RECONNECT_RETRY_MS = 250;

function log(adapter: string, message: string): void {
  process.stderr.write(`[${adapter}-companion] ${message}\n`);
}

export type LocalCompanionCliOptions = {
  adapter: "codex" | "claude" | "opencode" | "pi";
  cwd: string;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs: string[];
};

function parseCliArgs(argv: string[]): LocalCompanionCliOptions {
  let adapter: "codex" | "claude" | "opencode" | "pi" | null = null;
  let cwd = process.cwd();
  let sessionStartMode: BridgeSessionStartMode = "restore";
  const cliArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Internal companion usage: local-companion --adapter <codex|claude|opencode|pi> [--cwd <path>] [...cli args]",
          "",
          "Connects a visible local CLI to the matching bridge runtime for the current directory.",
          "Unknown arguments are forwarded to the visible CLI client.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--adapter") {
      if (!next || !["codex", "claude", "opencode", "pi"].includes(next)) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      adapter = next as "codex" | "claude" | "opencode" | "pi";
      i += 1;
      continue;
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--session-start-mode") {
      if (!next || !["restore", "new"].includes(next)) {
        throw new Error(`Invalid session start mode: ${next ?? "(missing)"}`);
      }
      sessionStartMode = next as BridgeSessionStartMode;
      i += 1;
      continue;
    }

    cliArgs.push(arg);
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude|opencode|pi>");
  }

  return { adapter, cwd, sessionStartMode, cliArgs };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMatchingEndpoint(
  options: LocalCompanionCliOptions,
): LocalCompanionEndpoint & { kind: LocalCompanionCliOptions["adapter"] } {
  const endpoint = readLocalCompanionEndpoint(options.cwd, {
    adapter: options.adapter,
  });
  if (!endpoint || endpoint.kind !== options.adapter) {
    throw new Error(
      `No active ${options.adapter} runtime was found for ${options.cwd}. Run "wechat-${options.adapter}" in that directory to recreate it.`,
    );
  }

  return endpoint as LocalCompanionEndpoint & { kind: LocalCompanionCliOptions["adapter"] };
}

export function shouldReconnectLocalCompanion(params: {
  shuttingDown: boolean;
  closeReason: LocalCompanionCloseReason | null | undefined;
}): boolean {
  return !params.shuttingDown && !params.closeReason;
}

export async function runLocalCompanion(options: LocalCompanionCliOptions): Promise<number> {
  const initialEndpoint = readMatchingEndpoint(options);

  if (
    initialEndpoint.kind === "codex" &&
    initialEndpoint.runtimeKind === "codex_runtime_host"
  ) {
    return await runCodexRemoteClientFromEndpoint(initialEndpoint, {
      extraCliArgs: options.cliArgs,
    });
  }

  const shouldRestoreInitialSession = options.sessionStartMode !== "new";
  const adapter = createBridgeAdapter({
    kind: initialEndpoint.kind,
    command: initialEndpoint.command,
    cwd: initialEndpoint.cwd,
    profile: initialEndpoint.profile,
    initialSharedSessionId:
      shouldRestoreInitialSession
        ? initialEndpoint.sharedSessionId ?? initialEndpoint.sharedThreadId
        : undefined,
    initialResumeConversationId: shouldRestoreInitialSession
      ? initialEndpoint.resumeConversationId
      : undefined,
    initialTranscriptPath: shouldRestoreInitialSession
      ? initialEndpoint.transcriptPath
      : undefined,
    sessionStartMode: options.sessionStartMode,
    renderMode: initialEndpoint.kind === "codex" ? "panel" : "companion",
    extraCliArgs: options.cliArgs,
  });

  let shuttingDown = false;
  let closeReason: LocalCompanionCloseReason | null = null;
  let activeSocket: net.Socket | null = null;
  let detachListener: (() => void) | null = null;
  let reconnectPromise: Promise<boolean> | null = null;
  let resolveExitCode: ((code: number) => void) | null = null;
  const exitCodePromise = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });
  let signalHandlersRegistered = false;

  const detachActiveSocket = (destroy = false) => {
    const socket = activeSocket;
    activeSocket = null;
    detachListener?.();
    detachListener = null;
    if (!socket) {
      return;
    }

    socket.removeAllListeners("close");
    socket.removeAllListeners("error");
    socket.on("error", () => {});
    if (destroy) {
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
    }
  };

  const resolveExit = (code: number) => {
    const resolve = resolveExitCode;
    if (!resolve) {
      return;
    }
    resolveExitCode = null;
    resolve(code);
  };

  const unregisterSignalHandlers = () => {
    if (!signalHandlersRegistered) {
      return;
    }
    signalHandlersRegistered = false;
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
    process.removeListener("SIGHUP", handleSighup);
    if (process.platform === "win32") {
      process.removeListener("SIGBREAK", handleSigbreak);
    }
  };

  const publishState = () => {
    if (!activeSocket) {
      return;
    }

    sendLocalCompanionMessage(activeSocket, {
      type: "state",
      state: adapter.getState(),
    });
  };

  const sendResponse = (
    socket: net.Socket,
    id: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ) => {
    sendLocalCompanionMessage(socket, {
      type: "response",
      id,
      ok,
      result,
      error,
    });
  };

  const announceClosing = (
    reason: LocalCompanionCloseReason,
    exitCode?: number,
  ) => {
    closeReason = reason;
    if (!activeSocket) {
      return;
    }
    sendLocalCompanionMessage(activeSocket, {
      type: "closing",
      reason,
      exitCode,
    });
  };

  const closeCompanion = async (
    exitCode = 0,
    reason: LocalCompanionCloseReason = "companion_shutdown",
  ) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    announceClosing(reason, exitCode);
    detachActiveSocket(false);
    try {
      await adapter.dispose();
    } catch {
      // Best effort cleanup.
    }
    resolveExit(exitCode);
  };

  const handleBridgeRequest = async (
    socket: net.Socket,
    message: Extract<LocalCompanionMessage, { type: "request" }>,
  ) => {
    try {
      switch (message.payload.command) {
        case "send_input":
          await adapter.sendInput(message.payload.text);
          sendResponse(socket, message.id, true);
          break;
        case "list_resume_sessions":
        case "list_resume_threads":
          sendResponse(
            socket,
            message.id,
            true,
            await adapter.listResumeSessions(message.payload.limit),
          );
          break;
        case "resume_session":
          await adapter.resumeSession(message.payload.sessionId);
          publishState();
          sendResponse(socket, message.id, true);
          break;
        case "resume_thread":
          await adapter.resumeSession(message.payload.threadId);
          publishState();
          sendResponse(socket, message.id, true);
          break;
        case "create_session":
          if (!adapter.createSession) {
            throw new Error(`/${adapter.getState().kind} does not support creating sessions from WeChat.`);
          }
          await adapter.createSession();
          publishState();
          sendResponse(socket, message.id, true);
          break;
        case "interrupt":
          sendResponse(socket, message.id, true, await adapter.interrupt());
          break;
        case "reset":
          await adapter.reset();
          publishState();
          sendResponse(socket, message.id, true);
          break;
        case "resolve_approval":
          sendResponse(
            socket,
            message.id,
            true,
            await adapter.resolveApproval(message.payload.action),
          );
          break;
        case "submit_user_input":
          sendResponse(
            socket,
            message.id,
            true,
            await adapter.submitUserInput(message.payload.answers),
          );
          break;
        case "dispose":
          sendResponse(socket, message.id, true);
          await closeCompanion(0, "bridge_dispose");
          break;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      sendResponse(socket, message.id, false, undefined, text);
    }
  };

  const connectToBridge = async (
    endpoint: LocalCompanionEndpoint,
  ): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({
        host: "127.0.0.1",
        port: endpoint.port,
      });

      let settled = false;
      let helloAcknowledged = false;
      let localDetach: (() => void) | null = null;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        localDetach?.();
        localDetach = null;
        try {
          socket.destroy();
        } catch {
          // Best effort cleanup.
        }
        reject(error);
      };

      socket.once("connect", () => {
        socket.setNoDelay(true);
        localDetach = attachLocalCompanionMessageListener(
          socket,
          (message: LocalCompanionMessage) => {
            if (!helloAcknowledged) {
              if (message.type === "hello_ack") {
                helloAcknowledged = true;
                closeReason = null;
                activeSocket = socket;
                detachListener = localDetach;
                if (!settled) {
                  settled = true;
                  resolve();
                }
              }
              return;
            }

            if (message.type !== "request") {
              return;
            }

            void handleBridgeRequest(socket, message);
          },
        );

        socket.once("close", () => {
          if (!settled) {
            fail(
              new Error(
                `The ${options.adapter} bridge closed the local companion socket before authentication.`,
              ),
            );
            return;
          }

          if (activeSocket === socket) {
            detachActiveSocket(false);
            void (async () => {
              if (
                !shouldReconnectLocalCompanion({
                  shuttingDown,
                  closeReason,
                })
              ) {
                return;
              }

              const reconnected = await reconnectToBridge();
              if (!reconnected && !shuttingDown) {
                await closeCompanion(1, "fatal_error");
              }
            })();
          }
        });

        socket.once("error", (error) => {
          if (!settled) {
            fail(
              error instanceof Error
                ? error
                : new Error(String(error)),
            );
          }
        });

        sendLocalCompanionMessage(socket, {
          type: "hello",
          token: endpoint.token,
          companionPid: process.pid,
        });
      });

      socket.once("error", (error) => {
        if (!settled) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  };

  const reconnectToBridge = async (): Promise<boolean> => {
    if (reconnectPromise) {
      return await reconnectPromise;
    }

    reconnectPromise = (async () => {
      const deadline = Date.now() + LOCAL_COMPANION_RECONNECT_GRACE_MS;
      let lastError = "";
      log(
        options.adapter,
        `Bridge connection dropped unexpectedly. Waiting up to ${Math.ceil(LOCAL_COMPANION_RECONNECT_GRACE_MS / 1000)}s to reconnect...`,
      );

      while (!shuttingDown && Date.now() < deadline) {
        try {
          const nextEndpoint = readMatchingEndpoint(options);
          await connectToBridge(nextEndpoint);
          publishState();
          log(options.adapter, `Reconnected to bridge ${nextEndpoint.instanceId}.`);
          return true;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await delay(LOCAL_COMPANION_RECONNECT_RETRY_MS);
        }
      }

      if (lastError) {
        log(
          options.adapter,
          `Bridge reconnection timed out after ${Math.ceil(LOCAL_COMPANION_RECONNECT_GRACE_MS / 1000)}s: ${lastError}`,
        );
      } else {
        log(
          options.adapter,
          `Bridge reconnection timed out after ${Math.ceil(LOCAL_COMPANION_RECONNECT_GRACE_MS / 1000)}s.`,
        );
      }
      return false;
    })();

    try {
      return await reconnectPromise;
    } finally {
      reconnectPromise = null;
    }
  };

  adapter.setEventSink((event) => {
    if (activeSocket) {
      sendLocalCompanionMessage(activeSocket, {
        type: "event",
        event,
      });
    }
    publishState();

    if (event.type === "fatal_error") {
      void closeCompanion(1, "fatal_error");
      return;
    }

    if (event.type === "status" && event.status === "stopped") {
      void closeCompanion(0, "worker_exit");
    }
  });

  const requestSignalShutdown = (signal: string) => {
    log(options.adapter, `Received ${signal}. Closing local companion.`);
    void closeCompanion(0, "signal");
  };

  const handleSigint = () => requestSignalShutdown("SIGINT");
  const handleSigterm = () => requestSignalShutdown("SIGTERM");
  const handleSighup = () => requestSignalShutdown("SIGHUP");
  const handleSigbreak = () => requestSignalShutdown("SIGBREAK");

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("SIGHUP", handleSighup);
  if (process.platform === "win32") {
    process.once("SIGBREAK", handleSigbreak);
  }
  signalHandlersRegistered = true;

  try {
    await connectToBridge(initialEndpoint);
    await adapter.start();
    publishState();
    log(options.adapter, `Connected to bridge ${initialEndpoint.instanceId}.`);
    return await exitCodePromise;
  } finally {
    unregisterSignalHandlers();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  migrateLegacyChannelFiles((message) => log("local", message));
  try {
    const options = parseCliArgs(argv);
    const exitCode = await runLocalCompanion(options);
    process.exit(exitCode);
  } catch (error) {
    const adapter = (() => {
      try {
        return parseCliArgs(argv).adapter;
      } catch {
        return "local";
      }
    })();
    log(adapter, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  void main();
}
