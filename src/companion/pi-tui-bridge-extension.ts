import net from "node:net";

type PiSessionManager = {
  getSessionFile(): string | undefined;
  getSessionId(): string;
};

type PiExtensionContext = {
  isIdle(): boolean;
  abort(): void;
  sessionManager: PiSessionManager;
  newSession(options?: {
    withSession?: (context: PiExtensionContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
  switchSession(
    sessionPath: string,
    options?: {
      withSession?: (context: PiExtensionContext) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean }>;
};

type PiExtensionApi = {
  on(
    event: string,
    handler: (event: Record<string, unknown>, context: PiExtensionContext) => unknown,
  ): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, context: PiExtensionContext) => Promise<void>;
    },
  ): void;
  sendUserMessage(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp";
      expandPromptTemplates?: boolean;
    },
  ): void;
};

type BridgeCommand = {
  id?: string;
  type?: string;
  text?: string;
  sessionPath?: string;
};

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env.CLI_BRIDGE_PI_TUI_PORT ?? "");
const BRIDGE_TOKEN = process.env.CLI_BRIDGE_PI_TUI_TOKEN ?? "";
const INTERNAL_NEW_COMMAND = "__cli_bridge_new";
const INTERNAL_SWITCH_COMMAND = "__cli_bridge_switch";
const MAX_BUFFER_SIZE = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function parseControlArgs(args: string): { id: string; value?: string } | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }
  const separatorIndex = trimmed.indexOf(" ");
  if (separatorIndex < 0) {
    return { id: trimmed };
  }
  return {
    id: trimmed.slice(0, separatorIndex),
    value: trimmed.slice(separatorIndex + 1),
  };
}

export default function piTuiBridgeExtension(pi: PiExtensionApi): void {
  if (!Number.isInteger(BRIDGE_PORT) || BRIDGE_PORT <= 0 || !BRIDGE_TOKEN) {
    return;
  }

  const socket = net.connect({ host: BRIDGE_HOST, port: BRIDGE_PORT });
  let buffer = "";
  let connected = false;
  const queuedFrames: Record<string, unknown>[] = [];
  let latestContext: PiExtensionContext | null = null;

  const writeFrame = (frame: Record<string, unknown>) => {
    if (socket.destroyed) {
      return;
    }
    if (!connected) {
      queuedFrames.push(frame);
      return;
    }
    socket.write(`${JSON.stringify(frame)}\n`);
  };

  const writeSessionState = (
    context: PiExtensionContext,
    reason: string,
  ) => {
    writeFrame({
      type: "session_state",
      sessionId: context.sessionManager.getSessionId(),
      sessionFile: context.sessionManager.getSessionFile(),
      reason,
    });
  };

  pi.registerCommand(INTERNAL_NEW_COMMAND, {
    description: "Internal CLI WeChat Bridge session command",
    handler: async (args, context) => {
      const parsed = parseControlArgs(args);
      if (!parsed) {
        return;
      }
      try {
        let sessionState: Record<string, unknown> = {};
        const result = await context.newSession({
          withSession: async (nextContext) => {
            writeSessionState(nextContext, "new");
            sessionState = {
              sessionId: nextContext.sessionManager.getSessionId(),
              sessionFile: nextContext.sessionManager.getSessionFile(),
            };
          },
        });
        writeFrame({
          type: "response",
          id: parsed.id,
          success: true,
          data: { ...result, ...sessionState },
        });
      } catch (error) {
        writeFrame({
          type: "response",
          id: parsed.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  pi.registerCommand(INTERNAL_SWITCH_COMMAND, {
    description: "Internal CLI WeChat Bridge session command",
    handler: async (args, context) => {
      const parsed = parseControlArgs(args);
      if (!parsed?.value) {
        return;
      }
      try {
        let sessionState: Record<string, unknown> = {};
        const result = await context.switchSession(parsed.value, {
          withSession: async (nextContext) => {
            writeSessionState(nextContext, "resume");
            sessionState = {
              sessionId: nextContext.sessionManager.getSessionId(),
              sessionFile: nextContext.sessionManager.getSessionFile(),
            };
          },
        });
        writeFrame({
          type: "response",
          id: parsed.id,
          success: true,
          data: { ...result, ...sessionState },
        });
      } catch (error) {
        writeFrame({
          type: "response",
          id: parsed.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.setNoDelay(true);
    socket.write(`${JSON.stringify({ type: "hello", token: BRIDGE_TOKEN })}\n`);
    connected = true;
    for (const frame of queuedFrames.splice(0)) {
      writeFrame(frame);
    }
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer = "";
      socket.destroy();
      return;
    }
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }
      let command: BridgeCommand;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          continue;
        }
        command = parsed;
      } catch {
        continue;
      }

      try {
        if (command.type === "prompt" && typeof command.text === "string") {
          if (!latestContext?.isIdle()) {
            throw new Error("Pi TUI is already processing a turn.");
          }
          pi.sendUserMessage(command.text);
          writeFrame({ type: "response", id: command.id, success: true });
        } else if (command.type === "abort") {
          latestContext?.abort();
          writeFrame({ type: "response", id: command.id, success: true });
        } else if (command.type === "new_session" && typeof command.id === "string") {
          pi.sendUserMessage(`/${INTERNAL_NEW_COMMAND} ${command.id}`, {
            expandPromptTemplates: true,
          });
        } else if (
          command.type === "switch_session" &&
          typeof command.id === "string" &&
          typeof command.sessionPath === "string"
        ) {
          pi.sendUserMessage(
            `/${INTERNAL_SWITCH_COMMAND} ${command.id} ${command.sessionPath}`,
            { expandPromptTemplates: true },
          );
        }
      } catch (error) {
        writeFrame({
          type: "response",
          id: command.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  socket.on("error", () => {
    // The visible TUI remains usable if the bridge side disappears.
  });

  pi.on("session_start", (event, context) => {
    latestContext = context;
    writeSessionState(
      context,
      typeof event.reason === "string" ? event.reason : "startup",
    );
  });
  pi.on("input", (event, context) => {
    latestContext = context;
    if (event.source === "interactive" && typeof event.text === "string") {
      writeFrame({ type: "local_input", text: event.text });
    }
  });
  pi.on("message_end", (event, context) => {
    latestContext = context;
    const text = extractAssistantText(event.message);
    if (!text) {
      return;
    }
    const message = isRecord(event.message) ? event.message : {};
    writeFrame({
      type: "assistant_message",
      text,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    });
  });
  pi.on("agent_start", (_event, context) => {
    latestContext = context;
    writeFrame({ type: "agent_start" });
  });
  pi.on("agent_settled", (_event, context) => {
    latestContext = context;
    writeSessionState(context, "settled");
    writeFrame({ type: "agent_settled" });
  });
}
