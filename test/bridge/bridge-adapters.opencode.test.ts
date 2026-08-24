import fs from "node:fs";

import { describe, expect, test } from "bun:test";

import {
  createBridgeAdapter,
  resolveDefaultAdapterCommand,
  getLocalCompanionCommandName,
} from "../../src/bridge/bridge-adapters.ts";
import {
  OpenCodeServerAdapter,
} from "../../src/bridge/bridge-adapters.opencode.ts";
import {
  LocalCompanionProxyAdapter,
} from "../../src/bridge/bridge-adapters.core.ts";
import {
  formatFinalReplyMessage,
  formatMirroredUserInputMessage,
  formatResumeSessionList,
  formatTaskFailedMessage,
} from "../../src/bridge/bridge-utils.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSdkSessionRecord(
  id: string,
  options: {
    directory?: string;
    workspaceID?: string;
    title?: string;
  } = {},
) {
  return {
    id,
    projectID: "project_1",
    workspaceID: options.workspaceID,
    directory: options.directory ?? process.cwd(),
    title: options.title ?? id,
    version: "1",
    time: {
      created: Date.now(),
      updated: Date.now(),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode adapter factory", () => {
  test("creates a LocalCompanionProxyAdapter for the bridge-side opencode entry", () => {
    const adapter = createBridgeAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });

    expect(adapter).toBeInstanceOf(LocalCompanionProxyAdapter);
  });

  test("creates an OpenCodeServerAdapter inside the local companion", () => {
    const adapter = createBridgeAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });

    expect(adapter).toBeInstanceOf(OpenCodeServerAdapter);
  });

  test("treats legacy embedded render mode like the bridge-side proxy path", () => {
    const adapter = createBridgeAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "embedded",
    });

    expect(adapter).toBeInstanceOf(LocalCompanionProxyAdapter);
  });

  test("creates an OpenCodeServerAdapter that accepts initialSharedSessionId option", () => {
    const adapter = createBridgeAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
      initialSharedSessionId: "session-initial-123",
    });

    expect(adapter).toBeInstanceOf(OpenCodeServerAdapter);
    // initialSharedSessionId is applied during start() → initializeSessions(),
    // not in the constructor.
    expect(adapter.getState().status).toBe("stopped");
  });
});

/* ------------------------------------------------------------------ */
/*  Constructor & initial state                                       */
/* ------------------------------------------------------------------ */

describe("OpenCodeServerAdapter initial state", () => {
  test("starts in stopped status with correct kind and command", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });

    const state = adapter.getState();
    expect(state.status).toBe("stopped");
    expect(state.kind).toBe("opencode");
    expect(state.command).toBe("opencode");
    expect(state.cwd).toBe(process.cwd());
  });

  test("preserves profile option when provided", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      profile: "wechat",
    });

    expect(adapter.getState().profile).toBe("wechat");
  });

  test("injects the managed route plugin through a temporary TUI config", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const internal = adapter as unknown as {
      tuiRouteConfigDir: string | null;
      tuiRouteConfigPath: string | null;
      startTuiRouteBridge(): Promise<void>;
      stopTuiRouteBridge(): Promise<void>;
      buildNativeClientEnv(): Record<string, string>;
    };

    try {
      await internal.startTuiRouteBridge();
      const configPath = internal.tuiRouteConfigPath;
      expect(configPath).not.toBeNull();
      const config = JSON.parse(fs.readFileSync(configPath!, "utf8")) as {
        plugin?: Array<[string, { port?: number; token?: string }]>;
      };
      expect(config.plugin?.[0]?.[0]).toMatch(/opencode-tui-bridge-plugin\.ts$/);
      expect(config.plugin?.[0]?.[1]).toEqual(
        expect.objectContaining({
          port: expect.any(Number),
          token: expect.any(String),
        }),
      );
      const env = internal.buildNativeClientEnv();
      expect(
        env.OPENCODE_CONFIG_DIR === internal.tuiRouteConfigDir ||
          env.OPENCODE_TUI_CONFIG === internal.tuiRouteConfigPath,
      ).toBe(true);
    } finally {
      const configDir = internal.tuiRouteConfigDir;
      await internal.stopTuiRouteBridge();
      if (configDir) {
        expect(fs.existsSync(configDir)).toBe(false);
      }
    }
  });

  test("appends extra CLI args only to the visible attach command", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
      extraCliArgs: ["--theme", "system"],
    });
    const internal = adapter as unknown as {
      serverPort: number;
      activeSessionId: string | null;
      buildNativeAttachArgs(): Promise<string[]>;
    };

    internal.serverPort = 8123;
    internal.activeSessionId = null;

    await expect(internal.buildNativeAttachArgs()).resolves.toEqual([
      "attach",
      "http://127.0.0.1:8123",
      "--dir",
      process.cwd(),
      "--theme",
      "system",
    ]);
  });

  test("passes the active session and cwd to the native attach client", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const internal = adapter as unknown as {
      serverPort: number;
      activeSessionId: string | null;
      client: {
        session: {
          get(options: { sessionID: string }): Promise<unknown>;
        };
      };
      buildNativeAttachArgs(): Promise<string[]>;
      buildNativeClientEnv(): Record<string, string>;
    };

    internal.serverPort = 8123;
    internal.activeSessionId = "ses_fresh";
    internal.client = {
      session: {
        get: async ({ sessionID }) => ({
          data: createSdkSessionRecord(sessionID),
          error: undefined,
          request: {},
          response: {},
        }),
      },
    };

    await expect(internal.buildNativeAttachArgs()).resolves.toEqual([
      "attach",
      "http://127.0.0.1:8123",
      "--dir",
      process.cwd(),
      "--session",
      "ses_fresh",
    ]);
    expect(JSON.parse(internal.buildNativeClientEnv().OPENCODE_ROUTE!)).toEqual({
      type: "session",
      sessionID: "ses_fresh",
    });
  });
});

describe("OpenCode health compatibility", () => {
  test("probes /global/health and accepts the supported 1.18 release line", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      serverPort: number;
      checkHealth(): Promise<void>;
    };
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    internal.serverPort = 8123;
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ healthy: true, version: "1.18.4" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await internal.checkHealth();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(urls).toEqual(["http://127.0.0.1:8123/global/health"]);
  });

  test("rejects OpenCode versions outside >=1.18.0 <2.0.0", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      isSupportedOpenCodeVersion(version: string): boolean;
    };

    expect(internal.isSupportedOpenCodeVersion("1.18.0")).toBe(true);
    expect(internal.isSupportedOpenCodeVersion("1.99.3")).toBe(true);
    expect(internal.isSupportedOpenCodeVersion("1.17.9")).toBe(false);
    expect(internal.isSupportedOpenCodeVersion("2.0.0")).toBe(false);
    expect(internal.isSupportedOpenCodeVersion("dev")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  startup session restore                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode startup session restore", () => {
  function createSdkSession(id: string, title = id) {
    return {
      id,
      projectID: "project_1",
      directory: process.cwd(),
      title,
      version: "1",
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    };
  }

  test("starts a fresh session when requested by the start launcher", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      sessionStartMode: "new",
      initialSharedSessionId: "session_old",
    });
    const calls: string[] = [];
    const internal = adapter as unknown as {
      client: {
        session: {
          list(): Promise<unknown>;
          create(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
      activeSessionId: string | null;
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      initializeSessions(): Promise<void>;
    };

    internal.client = {
      session: {
        list: async () => {
          calls.push("list");
          return {
            data: [createSdkSession("session_old")],
            error: undefined,
            request: {},
            response: {},
          };
        },
        create: async (options = {}) => {
          calls.push(`create:${options.directory ?? ""}`);
          return {
            data: createSdkSession("session_fresh"),
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    await internal.initializeSessions();

    expect(calls).toEqual([`create:${process.cwd()}`]);
    expect(internal.activeSessionId).toBe("session_fresh");
    expect(internal.state.sharedSessionId).toBe("session_fresh");
    expect(internal.state.sharedThreadId).toBe("session_fresh");
    expect(internal.state.activeRuntimeSessionId).toBe("session_fresh");
    expect(internal.state.lastSessionSwitchSource).toBeUndefined();
    expect(internal.state.lastSessionSwitchReason).toBeUndefined();
  });

  test("keeps the latest live session when the persisted shared session is gone", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      initialSharedSessionId: "session_missing",
    });
    const internal = adapter as unknown as {
      client: {
        session: {
          list(): Promise<unknown>;
          get(options: { sessionID: string }): Promise<unknown>;
        };
      };
      activeSessionId: string | null;
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      initializeSessions(): Promise<void>;
    };

    internal.client = {
      session: {
        list: async () => ({
          data: [createSdkSession("session_live")],
          error: undefined,
          request: {},
          response: {},
        }),
        get: async ({ sessionID }) => ({
          data: undefined,
          error: sessionID === "session_missing" ? new Error("Session not found") : undefined,
          request: {},
          response: {},
        }),
      },
    };

    await internal.initializeSessions();

    expect(internal.activeSessionId).toBe("session_live");
    expect(internal.state.sharedSessionId).toBe("session_live");
    expect(internal.state.sharedThreadId).toBe("session_live");
    expect(internal.state.activeRuntimeSessionId).toBe("session_live");
    expect(internal.state.lastSessionSwitchSource).toBeUndefined();
    expect(internal.state.lastSessionSwitchReason).toBeUndefined();
  });

  test("restores the persisted shared session only when the server can still load it", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      initialSharedSessionId: "session_restore",
    });
    const internal = adapter as unknown as {
      client: {
        session: {
          list(): Promise<unknown>;
          get(options: { sessionID: string }): Promise<unknown>;
        };
      };
      activeSessionId: string | null;
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      initializeSessions(): Promise<void>;
    };

    internal.client = {
      session: {
        list: async () => ({
          data: [createSdkSession("session_live")],
          error: undefined,
          request: {},
          response: {},
        }),
        get: async ({ sessionID }) => ({
          data: sessionID === "session_restore" ? createSdkSession("session_restore") : undefined,
          error: sessionID === "session_restore" ? undefined : new Error("Session not found"),
          request: {},
          response: {},
        }),
      },
    };

    await internal.initializeSessions();

    expect(internal.activeSessionId).toBe("session_restore");
    expect(internal.state.sharedSessionId).toBe("session_restore");
    expect(internal.state.sharedThreadId).toBe("session_restore");
    expect(internal.state.activeRuntimeSessionId).toBe("session_restore");
    expect(internal.state.lastSessionSwitchSource).toBe("restore");
    expect(internal.state.lastSessionSwitchReason).toBe("startup_restore");
  });
});

/* ------------------------------------------------------------------ */
/*  SSE event handling                                                 */
/* ------------------------------------------------------------------ */

describe("OpenCode SSE event dispatch", () => {
  function createTestAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      pendingPermission: unknown;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
      shuttingDown: boolean;
    };
    return { adapter, events, internal };
  }

  test("ignores server.connected and server.heartbeat events", () => {
    const { events, internal } = createTestAdapter();

    internal.handleSseEvent({ type: "server.connected" });
    internal.handleSseEvent({ type: "server.heartbeat" });

    expect(events).toHaveLength(0);
  });

  test("ignores events with non-record properties without crashing", () => {
    const { events, internal } = createTestAdapter();

    internal.handleSseEvent({ type: "session.idle", properties: "not a record" });
    internal.handleSseEvent({ type: "session.status", properties: null });
    internal.handleSseEvent({ type: "session.created", properties: 42 });

    expect(events).toHaveLength(0);
  });

  test("starts only the current local and global SSE loops", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      client: Record<string, unknown> | null;
      sseLoopPromise: Promise<void> | null;
      shuttingDown: boolean;
      startSseListener(): void;
      runSseLoop(streamName: string): Promise<void>;
    };
    const subscribedStreams: string[] = [];

    internal.client = {
      event: {},
      global: { syncEvent: { subscribe: async () => ({ stream: [] }) } },
    };
    internal.runSseLoop = async (streamName: string) => {
      subscribedStreams.push(streamName);
    };

    internal.startSseListener();
    await internal.sseLoopPromise;

    expect(subscribedStreams).toEqual(["event", "global-event"]);
  });
});

/* ------------------------------------------------------------------ */
/*  visible TUI session sync                                           */
/* ------------------------------------------------------------------ */

describe("OpenCode visible TUI session sync", () => {
  test("syncs the restored shared session into the visible TUI", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
      initialSharedSessionId: "session_restore",
    });
    const selectSessionCalls: Array<Record<string, unknown>> = [];
    const internal = adapter as unknown as {
      client: {
        session: {
          list(): Promise<unknown>;
          get(options: { sessionID: string }): Promise<unknown>;
        };
        tui: {
          selectSession(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
      initializeSessions(): Promise<void>;
      syncVisibleSessionToShared(options?: { force?: boolean }): Promise<void>;
    };

    internal.client = {
      session: {
        list: async () => ({
          data: [createSdkSessionRecord("session_live")],
          error: undefined,
          request: {},
          response: {},
        }),
        get: async ({ sessionID }) => ({
          data: sessionID === "session_restore" ? createSdkSessionRecord("session_restore") : undefined,
          error: sessionID === "session_restore" ? undefined : new Error("Session not found"),
          request: {},
          response: {},
        }),
      },
      tui: {
        selectSession: async (options = {}) => {
          selectSessionCalls.push(options);
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    await internal.initializeSessions();
    await internal.syncVisibleSessionToShared({ force: true });

    expect(selectSessionCalls).toEqual([
      expect.objectContaining({
        directory: process.cwd(),
        sessionID: "session_restore",
      }),
    ]);
  });

  test("selects the visible session before sending the first WeChat prompt", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const calls: string[] = [];
    let promptAsyncOptions: Record<string, unknown> | null = null;
    let selectSessionOptions: Record<string, unknown> | null = null;
    const internal = adapter as unknown as {
      client: {
        session: {
          create(options?: Record<string, unknown>): Promise<unknown>;
          promptAsync(options?: Record<string, unknown>): Promise<unknown>;
        };
        tui: {
          selectSession(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
    };

    internal.client = {
      session: {
        create: async () => {
          calls.push("create");
          return {
            data: createSdkSessionRecord("session_wechat_new", { workspaceID: "workspace_1" }),
            error: undefined,
            request: {},
            response: {},
          };
        },
        promptAsync: async (options = {}) => {
          calls.push("prompt");
          promptAsyncOptions = options;
          return {
            data: undefined,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
      tui: {
        selectSession: async (options = {}) => {
          calls.push("select");
          selectSessionOptions = options;
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    await adapter.sendInput("hello from wechat");

    expect(calls).toEqual(["create", "select", "prompt"]);
    expect(selectSessionOptions).toMatchObject({
      directory: process.cwd(),
      sessionID: "session_wechat_new",
      workspace: "workspace_1",
    });
    expect(promptAsyncOptions).toMatchObject({
      directory: process.cwd(),
      sessionID: "session_wechat_new",
      workspace: "workspace_1",
    });
  });

  test("creates a new OpenCode session from a WeChat control command", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    const selectSessionCalls: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { status: string; sharedSessionId?: string; sharedThreadId?: string };
      activeSessionId: string | null;
      client: {
        session: {
          create(options?: Record<string, unknown>): Promise<unknown>;
        };
        tui: {
          selectSession(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
    };

    internal.state.status = "idle";
    internal.activeSessionId = "session_old";
    internal.client = {
      session: {
        create: async () => ({
          data: createSdkSessionRecord("session_created_from_wechat", { workspaceID: "workspace_new" }),
          error: undefined,
          request: {},
          response: {},
        }),
      },
      tui: {
        selectSession: async (options = {}) => {
          selectSessionCalls.push(options);
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    await adapter.createSession();

    expect(internal.activeSessionId).toBe("session_created_from_wechat");
    expect(internal.state.sharedSessionId).toBe("session_created_from_wechat");
    expect(internal.state.sharedThreadId).toBe("session_created_from_wechat");
    expect(selectSessionCalls).toEqual([
      expect.objectContaining({
        directory: process.cwd(),
        sessionID: "session_created_from_wechat",
        workspace: "workspace_new",
      }),
    ]);
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_created_from_wechat",
        source: "wechat",
        reason: "wechat_resume",
      }),
    ]);
  });

  test("does not echo a local session switch back into the visible TUI", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: Array<{ type: string; sessionId?: string }> = [];
    const selectSessionCalls: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; sessionId?: string });
    });
    const internal = adapter as unknown as {
      client: {
        tui: {
          selectSession(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.client = {
      tui: {
        selectSession: async (options = {}) => {
          selectSessionCalls.push(options);
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "command.executed",
      properties: {
        name: "session",
        sessionID: "session_selected_local",
        arguments: "",
        workspaceID: "workspace_1",
      },
    });
    await wait(0);

    expect(selectSessionCalls).toEqual([]);
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_selected_local",
      }),
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  session.idle handling                                             */
/* ------------------------------------------------------------------ */

describe("OpenCode session.idle handling", () => {
  function createBusyAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      pendingPermission: unknown;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
      shuttingDown: boolean;
      workingNoticeSent: boolean;
    };

    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.activeSessionId = "session_idle_1";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Summarize the repo";

    return { adapter, events, internal };
  }

  test("completes a WeChat turn after session idle with final reply", async () => {
    const { events, internal } = createBusyAdapter();

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_idle_1",
          sessionID: "session_idle_1",
          type: "text",
          text: "Final visible answer",
        },
      },
    });

    // Real SDK: EventSessionIdle = { type: "session.idle", properties: { sessionID: string } }
    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    // Wait for the settle delay (OPENCODE_SESSION_IDLE_SETTLE_MS = 1_500).
    await wait(1_800);

    const statusEvents = events.filter((e) => e.type === "status");
    const taskCompleteEvents = events.filter((e) => e.type === "task_complete");
    const finalReplyEvents = events.filter((e) => e.type === "final_reply");

    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[statusEvents.length - 1]?.status).toBe("idle");
    expect(finalReplyEvents).toHaveLength(1);
    expect(finalReplyEvents[0]?.text).toBe("Final visible answer");
    expect(taskCompleteEvents).toHaveLength(1);
    expect(taskCompleteEvents[0]?.summary).toBe("Summarize the repo");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("(no output)");
  });

  test("emits the full visible answer instead of a 500 character tail summary", async () => {
    const { events, internal } = createBusyAdapter();
    const fullAnswer = [
      "FIRST_VISIBLE_SENTENCE",
      "x".repeat(700),
      "LAST_VISIBLE_SENTENCE",
    ].join(" ");

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_idle_long",
          sessionID: "session_idle_1",
          messageID: "m_idle_long",
          type: "text",
          text: fullAnswer,
        },
      },
    });

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    await wait(1_800);

    const finalReplyEvents = events.filter((e) => e.type === "final_reply");
    expect(finalReplyEvents).toHaveLength(1);
    expect(finalReplyEvents[0]?.text).toBe(fullAnswer);
  });

  test("ignores session idle when not in busy status", () => {
    const { events, internal } = createBusyAdapter();
    internal.state.status = "idle";

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    // No events should be emitted for idle→idle transitions.
    expect(events.filter((e) => e.type === "task_complete")).toHaveLength(0);
  });

  test("ignores idle signals from a foreign session", async () => {
    const { events, internal } = createBusyAdapter();

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_new_idle" },
    });

    await wait(100);

    expect(internal.activeSessionId).toBe("session_idle_1");
    expect(internal.state.status).toBe("busy");
    expect(events.filter((event) => event.type === "task_complete")).toHaveLength(0);
  });

  test("clears pending permission after session idle", async () => {
    const { events, internal } = createBusyAdapter();
    internal.state.status = "awaiting_approval";
    internal.pendingPermission = { code: "TESTCODE" };

    internal.handleSseEvent({
      type: "session.idle",
      properties: { sessionID: "session_idle_1" },
    });

    await wait(1_800);

    expect(internal.pendingPermission).toBeNull();
    expect(internal.state.status).toBe("idle");
  });
});

/* ------------------------------------------------------------------ */
/*  session.status handling                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode session.status handling", () => {
  test("transitions from idle to busy on running status", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; status?: string });
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      state: { status: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "s1";
    internal.state.status = "idle";

    // Real SDK: EventSessionStatus = { type: "session.status", properties: { sessionID: string, status: SessionStatus } }
    // SessionStatus = { type: "busy" } | { type: "idle" } | ...
    internal.handleSseEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "running" } },
    });

    expect(internal.state.status).toBe("busy");
    expect(events).toContainEqual(expect.objectContaining({ type: "status", status: "busy" }));
  });

  test("transitions from idle to busy on busy status", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; status?: string });
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      state: { status: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "s1";
    internal.state.status = "idle";

    internal.handleSseEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    });

    expect(internal.state.status).toBe("busy");
  });

  test("does not double-transition when already busy", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      state: { status: string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "s1";
    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "running" } },
    });

    // No new status event should be emitted.
    expect(events.filter((e) => e.type === "status")).toHaveLength(0);
  });

  test("ignores non-record properties without crashing", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "session.status", properties: null });
    internal.handleSseEvent({ type: "session.status", properties: { notStatus: "idle" } });
    internal.handleSseEvent({ type: "session.status", properties: { status: "flat-string" } });

    expect(events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  session.error handling                                             */
/* ------------------------------------------------------------------ */

describe("OpenCode session.error handling", () => {
  test("fails the tracked turn for non-abort session errors", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; message?: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; message?: string; status?: string });
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      state: { status: string; activeTurnOrigin?: string };
      hasAcceptedInput: boolean;
      currentPreview: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_error_1";
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Run the failing test suite";

    internal.handleSseEvent({
      type: "session.error",
      properties: {
        sessionID: "session_error_1",
        error: {
          name: "APIError",
          data: { message: "Provider request failed" },
        },
      },
    });

    expect(internal.state.status).toBe("idle");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(internal.hasAcceptedInput).toBe(false);
    expect(internal.currentPreview).toBe("(idle)");
    expect(events.filter((event) => event.type === "task_failed")).toEqual([
      expect.objectContaining({
        message: "Provider request failed",
      }),
    ]);
  });

  test("settles aborted turns without emitting task_failed", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      state: { status: string; activeTurnOrigin?: string };
      hasAcceptedInput: boolean;
      currentPreview: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_abort_1";
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Cancel the current turn";

    internal.handleSseEvent({
      type: "session.error",
      properties: {
        sessionID: "session_abort_1",
        error: {
          name: "MessageAbortedError",
          data: { message: "Session aborted" },
        },
      },
    });

    expect(internal.state.status).toBe("idle");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(internal.hasAcceptedInput).toBe(false);
    expect(internal.currentPreview).toBe("(idle)");
    expect(events.filter((event) => event.type === "task_failed")).toHaveLength(0);
  });

  test("ignores session.error from a foreign session while the current turn is still active", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.activeSessionId = "session_current";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Keep working on the current shared session";

    internal.handleSseEvent({
      type: "session.error",
      properties: {
        sessionID: "session_foreign",
        error: {
          name: "APIError",
          data: { message: "Foreign session failed" },
        },
      },
    });

    expect(internal.activeSessionId).toBe("session_current");
    expect(internal.state.status).toBe("busy");
    expect(internal.state.activeTurnOrigin).toBe("wechat");
    expect(internal.hasAcceptedInput).toBe(true);
    expect(internal.currentPreview).toBe("Keep working on the current shared session");
    expect(events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  permission.asked handling                                        */
/* ------------------------------------------------------------------ */

describe("OpenCode permission.asked handling", () => {
  function createPermissionAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      client: unknown;
      state: { status: string; activeTurnOrigin?: string; pendingApproval: unknown; pendingApprovalOrigin?: string };
      activeSessionId: string | null;
      pendingPermission: {
        sessionId: string;
        permissionId: string;
        code: string;
        createdAt: string;
        request: Record<string, unknown>;
      } | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    // Permission handling requires a non-null client.
    internal.client = {};
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.activeSessionId = "session_perm_1";

    return { adapter, events, internal };
  }

  test("emits approval_required with one-time code", () => {
    const { events, internal } = createPermissionAdapter();

    // Real SDK: EventPermissionAsked = { type: "permission.asked", properties: Permission }
    // Permission = { id, sessionID, title, type, metadata, ... }
    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_123",
        sessionID: "session_perm_1",
        type: "bash",
        title: "Run command: rm -rf /tmp/test",
        metadata: { command: "rm -rf /tmp/test" },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);

    expect(internal.state.status).toBe("awaiting_approval");
    expect(internal.pendingPermission).not.toBeNull();
    expect(internal.pendingPermission?.sessionId).toBe("session_perm_1");
    expect(internal.pendingPermission?.permissionId).toBe("perm_123");
    expect(internal.pendingPermission?.code).toMatch(/^[A-Z2-9]+$/);
    expect(internal.pendingPermission?.request).toMatchObject({
      source: "cli",
      toolName: "bash",
    });
  });

  test("extracts title and metadata from permission object", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_alt_456",
        sessionID: "session_perm_1",
        type: "web_fetch",
        title: "Fetch URL: https://example.com",
        metadata: { command: "curl https://example.com" },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);

    expect(internal.pendingPermission?.permissionId).toBe("perm_alt_456");
    expect(internal.pendingPermission?.request.toolName).toBe("web_fetch");
    expect(internal.pendingPermission?.request.commandPreview).toContain("curl https://example.com");
  });

  test("ignores permission events missing required fields", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.asked",
      properties: { type: "bash" },
    });

    expect(events.filter((e) => e.type === "approval_required")).toHaveLength(0);
    expect(internal.pendingPermission).toBeNull();
    expect(internal.state.status).toBe("busy");
  });

  test("works with minimal permission properties", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_789",
        sessionID: "session_perm_1",
        title: "Permission request",
        type: "unknown",
        metadata: {},
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);

    expect(internal.pendingPermission?.request.toolName).toBe("unknown");
  });

  test("accepts v2 permission.asked events", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_req_123",
        sessionID: "session_perm_1",
        permission: "bash",
        patterns: ["npm test"],
        metadata: { command: "npm test" },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);
    expect(internal.pendingPermission?.permissionId).toBe("perm_req_123");
    expect(internal.pendingPermission?.request).toMatchObject({
      toolName: "bash",
      commandPreview: "npm test",
    });
  });

  test("auto-rejects outbound attachment staging permission events", async () => {
    const { events, internal } = createPermissionAdapter();
    const responses: Array<Record<string, unknown>> = [];
    internal.client = {
      permission: {
        reply: async (parameters: Record<string, unknown>) => {
          responses.push(parameters);
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_outbound_1",
        sessionID: "session_perm_1",
        permission: "bash",
        metadata: {
          command:
            'Copy-Item "C:/Users/unlin/Desktop/report.docx" "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23/report.docx"',
        },
      },
    });

    await wait(10);

    expect(responses).toEqual([
      expect.objectContaining({
        requestID: "perm_outbound_1",
        reply: "reject",
      }),
    ]);
    expect(events.filter((e) => e.type === "approval_required")).toHaveLength(0);
    expect(internal.pendingPermission).toBeNull();
    expect(internal.state.status).toBe("busy");
  });

  test("auto-rejects outbound external directory permissions from lowercase metadata paths", async () => {
    const { events, internal } = createPermissionAdapter();
    const responses: Array<Record<string, unknown>> = [];
    internal.client = {
      permission: {
        reply: async (parameters: Record<string, unknown>) => {
          responses.push(parameters);
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_outbound_dir",
        sessionID: "session_perm_1",
        permission: "external_directory",
        patterns: ["C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23/*"],
        metadata: {
          filepath:
            "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23/report.docx",
          parentDir:
            "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23",
        },
      },
    });

    await wait(10);

    expect(responses).toEqual([
      expect.objectContaining({
        requestID: "perm_outbound_dir",
        reply: "reject",
      }),
    ]);
    expect(events.filter((e) => e.type === "approval_required")).toHaveLength(0);
    expect(internal.pendingPermission).toBeNull();
  });

  test("keeps ordinary external directory permissions user-controlled", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.asked",
      properties: {
        id: "perm_external_ok",
        sessionID: "session_perm_1",
        permission: "external_directory",
        patterns: ["C:/Users/unlin/Desktop/*"],
        metadata: {
          filepath: "C:/Users/unlin/Desktop/report.docx",
          parentDir: "C:/Users/unlin/Desktop",
        },
      },
    });

    const approvalEvents = events.filter((e) => e.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);
    expect(internal.pendingPermission?.permissionId).toBe("perm_external_ok");
  });
});

describe("OpenCode question handling", () => {
  function createQuestionAdapter() {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const internal = adapter as unknown as {
      client: Record<string, unknown>;
      state: {
        status: string;
        activeTurnOrigin?: string;
        pendingUserInput?: unknown;
        pendingUserInputOrigin?: string;
      };
      activeSessionId: string | null;
      activeWorkspaceId: string | null;
      pendingQuestion: {
        sessionId: string;
        requestId: string;
        request: { questions: Array<{ id: string }> };
      } | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };
    internal.client = {};
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.activeSessionId = "session_question_1";
    internal.activeWorkspaceId = "workspace_1";
    return { adapter, events, internal };
  }

  function askQuestions(internal: ReturnType<typeof createQuestionAdapter>["internal"]): void {
    internal.handleSseEvent({
      type: "question.asked",
      properties: {
        id: "question_request_1",
        sessionID: "session_question_1",
        questions: [
          {
            header: "Targets",
            question: "Which targets should be updated?",
            multiple: true,
            custom: true,
            options: [
              { label: "CLI", description: "Update the CLI." },
              { label: "Docs", description: "Update documentation." },
            ],
          },
          {
            header: "Mode",
            question: "Which mode should be used?",
            options: [
              { label: "Safe", description: "Use conservative behavior." },
              { label: "Fast", description: "Prefer speed." },
            ],
          },
        ],
      },
    });
  }

  test("maps question.asked into ordered generic user input", () => {
    const { events, internal } = createQuestionAdapter();

    askQuestions(internal);

    expect(internal.state.status).toBe("awaiting_input");
    expect(internal.state.pendingUserInputOrigin).toBe("wechat");
    expect(internal.pendingQuestion).toMatchObject({
      sessionId: "session_question_1",
      requestId: "question_request_1",
      request: {
        questions: [
          {
            id: "question_1",
            multiple: true,
            isOther: true,
            customAnswerMode: "value",
          },
          {
            id: "question_2",
            multiple: false,
            isOther: false,
            customAnswerMode: "value",
          },
        ],
      },
    });
    expect(events.filter((event) => event.type === "user_input_required")).toHaveLength(1);
  });

  test("submits OpenCode answers in the original question order", async () => {
    const { adapter, internal } = createQuestionAdapter();
    const replies: Array<Record<string, unknown>> = [];
    internal.client = {
      question: {
        reply: async (parameters: Record<string, unknown>) => {
          replies.push(parameters);
          return { data: true, error: undefined, request: {}, response: {} };
        },
      },
    };
    askQuestions(internal);

    await expect(
      adapter.submitUserInput({
        question_2: ["Safe"],
        question_1: ["CLI", "custom-target"],
      }),
    ).resolves.toBe(true);

    expect(replies).toEqual([
      {
        requestID: "question_request_1",
        directory: process.cwd(),
        workspace: "workspace_1",
        answers: [["CLI", "custom-target"], ["Safe"]],
      },
    ]);
    expect(internal.pendingQuestion).toBeNull();
    expect(internal.state.pendingUserInput).toBeNull();
    expect(internal.state.status).toBe("busy");
  });

  test("rejects a pending OpenCode question before aborting on /stop", async () => {
    const { adapter, internal } = createQuestionAdapter();
    const calls: string[] = [];
    internal.client = {
      question: {
        reject: async () => {
          calls.push("reject");
          return { data: true, error: undefined, request: {}, response: {} };
        },
      },
      session: {
        abort: async () => {
          calls.push("abort");
          return { data: true, error: undefined, request: {}, response: {} };
        },
      },
    };
    askQuestions(internal);

    await expect(adapter.interrupt()).resolves.toBe(true);

    expect(calls).toEqual(["reject", "abort"]);
    expect(internal.pendingQuestion).toBeNull();
    expect(internal.state.pendingUserInput).toBeNull();
  });

  test("clears pending input when OpenCode reports a local reply", () => {
    const { internal } = createQuestionAdapter();
    askQuestions(internal);

    internal.handleSseEvent({
      type: "question.replied",
      properties: {
        sessionID: "session_question_1",
        requestID: "question_request_1",
        answers: [["CLI"], ["Safe"]],
      },
    });

    expect(internal.pendingQuestion).toBeNull();
    expect(internal.state.pendingUserInput).toBeNull();
    expect(internal.state.status).toBe("busy");
  });
});

/* ------------------------------------------------------------------ */
/*  session.created handling                                           */
/* ------------------------------------------------------------------ */

describe("OpenCode session.created handling", () => {
  test("follows a new local session created during a local turn", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; sessionId?: string; source?: string });
    });
    const internal = adapter as unknown as {
      state: {
        status: string;
        activeTurnOrigin?: string;
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      hasAcceptedInput: boolean;
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "local";
    internal.hasAcceptedInput = true;
    internal.activeSessionId = "session_old_local";

    // Real SDK: EventSessionCreated = { type: "session.created", properties: { info: Session } }
    internal.handleSseEvent({
      type: "session.created",
      properties: { info: { id: "session_new_1", title: "Test session" } },
    });

    expect(internal.activeSessionId).toBe("session_new_1");
    expect(internal.state.sharedSessionId).toBe("session_new_1");
    expect(internal.state.sharedThreadId).toBe("session_new_1");
    expect(internal.state.activeRuntimeSessionId).toBe("session_new_1");
    expect(internal.state.lastSessionSwitchSource).toBe("local");
    expect(internal.state.lastSessionSwitchReason).toBe("local_turn");

    const switchEvents = events.filter((e) => e.type === "session_switched");
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0]).toMatchObject({
      sessionId: "session_new_1",
      source: "local",
      reason: "local_turn",
    });
  });

  test("ignores bootstrap session.created events until an authoritative local follow signal arrives", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({
      type: "session.created",
      properties: { info: { id: "session_bootstrap_1", title: "Bootstrap session" } },
    });

    expect(internal.activeSessionId).toBeNull();
    expect(internal.state.sharedSessionId).toBeUndefined();
    expect(internal.state.sharedThreadId).toBeUndefined();
    expect(internal.state.activeRuntimeSessionId).toBeUndefined();
    expect(internal.state.lastSessionSwitchSource).toBeUndefined();
    expect(internal.state.lastSessionSwitchReason).toBeUndefined();
    expect(events.filter((event) => event.type === "session_switched")).toHaveLength(0);
  });

  test("follows a session.created event after a local new-session command", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.state.sharedSessionId = "session_old_local";
    internal.state.sharedThreadId = "session_old_local";
    internal.state.activeRuntimeSessionId = "session_old_local";

    internal.handleSseEvent({
      type: "command.executed",
      properties: { name: "session.new", arguments: "" },
    });
    internal.handleSseEvent({
      type: "session.created",
      properties: { info: { id: "session_new_from_local", title: "New local session" } },
    });

    expect(internal.activeSessionId).toBe("session_new_from_local");
    expect(internal.state.sharedSessionId).toBe("session_new_from_local");
    expect(internal.state.sharedThreadId).toBe("session_new_from_local");
    expect(internal.state.activeRuntimeSessionId).toBe("session_new_from_local");
    expect(internal.state.lastSessionSwitchSource).toBe("local");
    expect(internal.state.lastSessionSwitchReason).toBe("local_follow");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_new_from_local",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("follows a new local session created after startup without a command marker", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.state.sharedSessionId = "session_old_local";
    internal.state.sharedThreadId = "session_old_local";
    internal.state.activeRuntimeSessionId = "session_old_local";

    internal.handleSseEvent({
      type: "session.created",
      properties: {
        session: {
          id: "session_created_without_marker",
          directory: process.cwd(),
        },
      },
    });

    expect(internal.activeSessionId).toBe("session_created_without_marker");
    expect(internal.state.sharedSessionId).toBe("session_created_without_marker");
    expect(internal.state.sharedThreadId).toBe("session_created_without_marker");
    expect(internal.state.activeRuntimeSessionId).toBe("session_created_without_marker");
    expect(internal.state.lastSessionSwitchSource).toBe("local");
    expect(internal.state.lastSessionSwitchReason).toBe("local_follow");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_created_without_marker",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("follows unscoped companion global session.created events after startup", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      activeSessionId: string | null;
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.state.sharedSessionId = "session_old_local";
    internal.state.sharedThreadId = "session_old_local";
    internal.state.activeRuntimeSessionId = "session_old_local";

    const globalEvent = internal.normalizeSdkEvent({
      payload: {
        type: "session.created",
        properties: {
          sessionID: "session_unscoped_created",
          info: { id: "session_unscoped_created", title: "New local session" },
        },
      },
    });

    expect(globalEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(globalEvent!, "global-event")).toBe(true);
    internal.handleSseEvent(globalEvent!);

    expect(internal.activeSessionId).toBe("session_unscoped_created");
    expect(internal.state.sharedSessionId).toBe("session_unscoped_created");
    expect(internal.state.sharedThreadId).toBe("session_unscoped_created");
    expect(internal.state.activeRuntimeSessionId).toBe("session_unscoped_created");
    expect(internal.state.lastSessionSwitchSource).toBe("local");
    expect(internal.state.lastSessionSwitchReason).toBe("local_follow");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_unscoped_created",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("follows the first unscoped companion session.created after a local new command", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
      };
      activeSessionId: string | null;
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
    };

    internal.handleSseEvent({
      type: "tui.command.execute",
      properties: { command: "session.new" },
    });

    const globalEvent = internal.normalizeSdkEvent({
      payload: {
        type: "session.created",
        properties: {
          sessionID: "session_first_unscoped",
          info: { id: "session_first_unscoped", title: "First local session" },
        },
      },
    });

    expect(globalEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(globalEvent!, "global-event")).toBe(true);
    internal.handleSseEvent(globalEvent!);

    expect(internal.activeSessionId).toBe("session_first_unscoped");
    expect(internal.state.sharedSessionId).toBe("session_first_unscoped");
    expect(internal.state.sharedThreadId).toBe("session_first_unscoped");
    expect(internal.state.activeRuntimeSessionId).toBe("session_first_unscoped");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_first_unscoped",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("ignores session.created with missing session ID", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "session.created", properties: {} });
    internal.handleSseEvent({ type: "session.created", properties: { tool: "bash" } });
    internal.handleSseEvent({ type: "session.created", properties: { info: {} } });
    internal.handleSseEvent({ type: "session.created", properties: { info: { title: "no id" } } });

    expect(events.filter((e) => e.type === "session_switched")).toHaveLength(0);
  });

  test("ignores foreign session.updated events once a shared session is established", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; sessionId?: string; source?: string });
    });
    const internal = adapter as unknown as {
      state: {
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        lastSessionSwitchSource?: string;
        lastSessionSwitchReason?: string;
      };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old";
    internal.state.sharedSessionId = "session_old";
    internal.state.sharedThreadId = "session_old";
    internal.state.activeRuntimeSessionId = "session_old";

    internal.handleSseEvent({
      type: "session.updated",
      properties: { sessionID: "session_new_2", info: { id: "session_new_2", title: "Updated session" } },
    });

    expect(internal.activeSessionId).toBe("session_old");
    expect(internal.state.sharedSessionId).toBe("session_old");
    expect(internal.state.sharedThreadId).toBe("session_old");
    expect(internal.state.activeRuntimeSessionId).toBe("session_old");
    expect(internal.state.lastSessionSwitchSource).toBeUndefined();
    expect(internal.state.lastSessionSwitchReason).toBeUndefined();
    expect(events.filter((e) => e.type === "session_switched")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  local TUI tracking                                                 */
/* ------------------------------------------------------------------ */

describe("OpenCode local TUI tracking", () => {
  test("emits a single local draft notice before submit", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; level?: string });
    });
    const internal = adapter as unknown as {
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "Review " } });
    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "the bridge flow" } });

    expect(events.filter((event) => event.type === "notice")).toEqual([
      expect.objectContaining({
        level: "info",
        text: "OpenCode local draft:\nReview",
      }),
    ]);

    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.submit" } });

    expect(events.filter((event) => event.type === "mirrored_user_input")).toEqual([
      expect.objectContaining({
        text: "Review the bridge flow",
      }),
    ]);
  });

  test("mirrors a submitted local prompt as a local turn", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; origin?: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; origin?: string; status?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string; lastInputAt?: string };
      currentPreview: string;
      hasAcceptedInput: boolean;
      pendingLocalPrompt: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "Review " } });
    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "the bridge flow" } });
    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.submit" } });

    expect(internal.pendingLocalPrompt).toBe("");
    expect(internal.hasAcceptedInput).toBe(true);
    expect(internal.currentPreview).toBe("Review the bridge flow");
    expect(internal.state.status).toBe("busy");
    expect(internal.state.activeTurnOrigin).toBe("local");
    expect(typeof internal.state.lastInputAt).toBe("string");

    const mirroredEvents = events.filter((event) => event.type === "mirrored_user_input");
    expect(mirroredEvents).toHaveLength(1);
    expect(mirroredEvents[0]).toMatchObject({
      text: "Review the bridge flow",
      origin: "local",
    });
  });

  test("deduplicates repeated prompt events across SSE streams", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      pendingLocalPrompt: string;
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldSkipDuplicateSdkEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
    };

    const appendEvent = internal.normalizeSdkEvent({
      type: "tui.prompt.append",
      properties: { text: "Review the bridge flow" },
    });
    expect(appendEvent).not.toBeNull();

    if (!internal.shouldSkipDuplicateSdkEvent(appendEvent!, "event")) {
      internal.handleSseEvent(appendEvent!);
    }
    if (!internal.shouldSkipDuplicateSdkEvent(appendEvent!, "global-event")) {
      internal.handleSseEvent(appendEvent!);
    }

    const submitEvent = internal.normalizeSdkEvent({
      type: "tui.command.execute",
      properties: { command: "prompt.submit" },
    });
    expect(submitEvent).not.toBeNull();

    if (!internal.shouldSkipDuplicateSdkEvent(submitEvent!, "event")) {
      internal.handleSseEvent(submitEvent!);
    }
    if (!internal.shouldSkipDuplicateSdkEvent(submitEvent!, "global-event")) {
      internal.handleSseEvent(submitEvent!);
    }

    expect(internal.pendingLocalPrompt).toBe("");
    expect(events.filter((event) => event.type === "notice")).toEqual([
      expect.objectContaining({
        text: "OpenCode local draft:\nReview the bridge flow",
      }),
    ]);
    expect(events.filter((event) => event.type === "mirrored_user_input")).toEqual([
      expect.objectContaining({
        text: "Review the bridge flow",
      }),
    ]);
  });

  test("clears the buffered local prompt before submit", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      pendingLocalPrompt: string;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.handleSseEvent({ type: "tui.prompt.append", properties: { text: "temporary draft" } });
    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.clear" } });
    internal.handleSseEvent({ type: "tui.command.execute", properties: { command: "prompt.submit" } });

    expect(internal.pendingLocalPrompt).toBe("");
    expect(internal.state.status).toBe("stopped");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(events.filter((event) => event.type === "notice")).toEqual([
      expect.objectContaining({
        text: "OpenCode local draft:\ntemporary draft",
      }),
    ]);
    expect(events.filter((event) => event.type === "mirrored_user_input")).toHaveLength(0);
  });

  test("tracks local TUI session selections as local session switches", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "tui.session.select",
      properties: { sessionID: "session_selected_local" },
    });

    expect(internal.activeSessionId).toBe("session_selected_local");
    expect(internal.state.sharedSessionId).toBe("session_selected_local");
    expect(internal.state.sharedThreadId).toBe("session_selected_local");
    expect(internal.state.activeRuntimeSessionId).toBe("session_selected_local");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_selected_local",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("tracks camelCase local TUI session selections", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "tui.session.select",
      properties: { sessionId: "session_selected_camel" },
    });

    expect(internal.activeSessionId).toBe("session_selected_camel");
    expect(internal.state.sharedSessionId).toBe("session_selected_camel");
    expect(internal.state.sharedThreadId).toBe("session_selected_camel");
    expect(internal.state.activeRuntimeSessionId).toBe("session_selected_camel");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_selected_camel",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("tracks /session command executions as local session switches", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "command.executed",
      properties: { name: "session", sessionID: "session_selected_via_command", arguments: "" },
    });

    expect(internal.activeSessionId).toBe("session_selected_via_command");
    expect(internal.state.sharedSessionId).toBe("session_selected_via_command");
    expect(internal.state.sharedThreadId).toBe("session_selected_via_command");
    expect(internal.state.activeRuntimeSessionId).toBe("session_selected_via_command");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_selected_via_command",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("local session switches immediately clear a running wechat turn", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; status?: string; sessionId?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; status?: string; sessionId?: string });
    });
    const internal = adapter as unknown as {
      state: {
        status: string;
        activeTurnOrigin?: string;
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
        pendingApproval?: unknown;
        pendingApprovalOrigin?: string;
      };
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      pendingPermission: unknown;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_wechat_old";
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "hihao";

    internal.handleSseEvent({
      type: "tui.session.select",
      properties: { sessionID: "session_local_new" },
    });

    expect(internal.activeSessionId).toBe("session_local_new");
    expect(internal.state.sharedSessionId).toBe("session_local_new");
    expect(internal.state.sharedThreadId).toBe("session_local_new");
    expect(internal.state.activeRuntimeSessionId).toBe("session_local_new");
    expect(internal.state.status).toBe("idle");
    expect(internal.state.activeTurnOrigin).toBeUndefined();
    expect(internal.state.pendingApproval).toBeNull();
    expect(internal.state.pendingApprovalOrigin).toBeUndefined();
    expect(internal.pendingPermission).toBeNull();
    expect(internal.hasAcceptedInput).toBe(false);
    expect(internal.currentPreview).toBe("(idle)");
    expect(events.filter((event) => event.type === "task_failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "task_complete")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_local_new",
      }),
    ]);
  });

  test("ignores sync session.updated events without an explicit local session selection signal", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "session.updated.1",
      data: { sessionID: "session_selected_via_sync", info: { id: "session_selected_via_sync" } },
    });

    expect(internal.activeSessionId).toBe("session_old_local");
    expect(internal.state.sharedSessionId).toBeUndefined();
    expect(internal.state.sharedThreadId).toBeUndefined();
    expect(internal.state.activeRuntimeSessionId).toBeUndefined();
    expect(events.filter((event) => event.type === "session_switched")).toHaveLength(0);
  });

  test("ignores payload-wrapped global sync session updates without an explicit local selection", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
      normalizeSdkEvent(event: unknown): { type: string; properties?: unknown; data?: unknown } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown },
        streamName: string,
      ): boolean;
    };

    internal.activeSessionId = "session_old_local";

    const syncEvent = internal.normalizeSdkEvent({
      payload: {
        type: "session.updated.1",
        data: {
          sessionID: "session_selected_via_global_sync",
          info: {
            id: "session_selected_via_global_sync",
            directory: process.cwd(),
          },
        },
      },
    });

    expect(syncEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(syncEvent!, "global-event")).toBe(true);
    internal.handleSseEvent(syncEvent!);

    expect(internal.activeSessionId).toBe("session_old_local");
    expect(internal.state.sharedSessionId).toBeUndefined();
    expect(internal.state.sharedThreadId).toBeUndefined();
    expect(internal.state.activeRuntimeSessionId).toBeUndefined();
    expect(events.filter((event) => event.type === "session_switched")).toHaveLength(0);
  });

  test("follows payload-wrapped global events for the current directory", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
    };

    internal.activeSessionId = "session_old_local";

    const globalEvent = internal.normalizeSdkEvent({
      directory: process.cwd(),
      payload: {
        type: "command.executed",
        properties: {
          name: "session",
          sessionID: "session_selected_via_global_event",
          arguments: "",
          messageID: "msg_1",
        },
      },
    });

    expect(globalEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(globalEvent!, "global-event")).toBe(true);
    internal.handleSseEvent(globalEvent!);

    expect(internal.activeSessionId).toBe("session_selected_via_global_event");
    expect(internal.state.sharedSessionId).toBe("session_selected_via_global_event");
    expect(internal.state.sharedThreadId).toBe("session_selected_via_global_event");
    expect(internal.state.activeRuntimeSessionId).toBe("session_selected_via_global_event");
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "session_selected_via_global_event",
        source: "local",
        reason: "local_follow",
      }),
    ]);
  });

  test("normalizes newer global sync payloads carried by the global event stream", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
    };

    const syncEvent = internal.normalizeSdkEvent({
      directory: process.cwd(),
      payload: {
        type: "sync",
        id: "global_event_1",
        syncEvent: {
          type: "session.updated.1",
          id: "sync_event_1",
          seq: 1,
          aggregateID: "session_newer_global_sync",
          data: {
            sessionID: "session_newer_global_sync",
            info: {
              id: "session_newer_global_sync",
              directory: process.cwd(),
            },
          },
        },
      },
    });

    expect(syncEvent).toMatchObject({
      type: "session.updated.1",
      directory: process.cwd(),
      data: {
        sessionID: "session_newer_global_sync",
        info: {
          id: "session_newer_global_sync",
          directory: process.cwd(),
        },
      },
    });
    expect(internal.shouldHandleSseEvent(syncEvent!, "global-event")).toBe(true);
  });

  test("ignores payload-wrapped global sync session updates from another directory", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { sharedSessionId?: string; sharedThreadId?: string; activeRuntimeSessionId?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
      normalizeSdkEvent(event: unknown): { type: string; properties?: unknown; data?: unknown } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown },
        streamName: string,
      ): boolean;
    };

    internal.activeSessionId = "session_old_local";
    internal.handleSseEvent({
      type: "tui.command.execute",
      properties: { command: "session.list" },
    });

    const syncEvent = internal.normalizeSdkEvent({
      payload: {
        type: "session.updated.1",
        data: {
          sessionID: "session_other_workspace",
          info: {
            id: "session_other_workspace",
            directory: "C:\\other-workspace",
          },
        },
      },
    });

    expect(syncEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(syncEvent!, "global-sync")).toBe(false);

    expect(internal.activeSessionId).toBe("session_old_local");
    expect(internal.state.sharedSessionId).toBeUndefined();
    expect(events.filter((event) => event.type === "session_switched")).toHaveLength(0);
  });

  test("ignores payload-wrapped global events from another directory", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; sessionId?: string; source?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; sessionId?: string; source?: string; reason?: string },
      );
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
    };

    internal.activeSessionId = "session_old_local";

    const globalEvent = internal.normalizeSdkEvent({
      directory: "C:\\other-workspace",
      payload: {
        type: "command.executed",
        properties: {
          name: "session",
          sessionID: "session_other_workspace",
          arguments: "",
          messageID: "msg_1",
        },
      },
    });

    expect(globalEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(globalEvent!, "global-event")).toBe(false);
    expect(events.filter((event) => event.type === "session_switched")).toHaveLength(0);
  });

  test("accepts unscoped global TUI prompt events in companion mode", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      normalizeSdkEvent(
        event: unknown,
      ): { type: string; properties?: unknown; data?: unknown; directory?: string } | null;
      shouldHandleSseEvent(
        event: { type: string; properties?: unknown; data?: unknown; directory?: string },
        streamName: string,
      ): boolean;
      handleSseEvent(event: { type: string; properties?: unknown; data?: unknown }): void;
    };

    const appendEvent = internal.normalizeSdkEvent({
      payload: {
        type: "tui.prompt.append",
        properties: { text: "Review the bridge flow" },
      },
    });
    expect(appendEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(appendEvent!, "global-event")).toBe(true);
    internal.handleSseEvent(appendEvent!);

    const submitEvent = internal.normalizeSdkEvent({
      payload: {
        type: "tui.command.execute",
        properties: { command: "prompt.submit" },
      },
    });
    expect(submitEvent).not.toBeNull();
    expect(internal.shouldHandleSseEvent(submitEvent!, "global-event")).toBe(true);
    internal.handleSseEvent(submitEvent!);

    expect(events.filter((event) => event.type === "notice")).toEqual([
      expect.objectContaining({
        text: "OpenCode local draft:\nReview the bridge flow",
      }),
    ]);
    expect(events.filter((event) => event.type === "mirrored_user_input")).toEqual([
      expect.objectContaining({
        text: "Review the bridge flow",
      }),
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  message.part.updated handling                                      */
/* ------------------------------------------------------------------ */

describe("OpenCode message.part.updated handling", () => {
  test("forwards text content via delta when busy", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.activeSessionId = "s1";

    // Real SDK: EventMessagePartUpdated = { type: "message.part.updated", properties: { part: Part, delta?: string } }
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", sessionID: "s1", type: "text" }, delta: "Hello from OpenCode" },
    });

    // Output goes through OutputBatcher (1 second delay), so immediate flush
    // won't produce events yet. But lastOutputAt should be updated.
    expect(internal.state.lastOutputAt).toBeTruthy();
  });

  test("forwards legitimate repeated delta fragments instead of dropping them", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      consumeVisiblePartDelta(partId: string, delta: string): string;
      emittedTextByPartId: Map<string, string>;
    };

    expect(internal.consumeVisiblePartDelta("p1", "hello ha")).toBe("hello ha");
    // The model genuinely repeated " ha" (old suffix heuristic ate this
    // because the accumulated text happened to end with the same fragment).
    expect(internal.consumeVisiblePartDelta("p1", " ha")).toBe(" ha");
    // Repeated table separators must survive too.
    expect(internal.consumeVisiblePartDelta("p1", " | done")).toBe(" | done");
    expect(internal.consumeVisiblePartDelta("p1", " |")).toBe(" |");

    // A full replay of everything emitted so far is still deduplicated.
    expect(internal.consumeVisiblePartDelta("p1", "hello ha ha | done |")).toBe("");
    // A delta carrying the accumulated text plus new content yields only the tail.
    internal.emittedTextByPartId.set("p2", "part one");
    expect(internal.consumeVisiblePartDelta("p2", "part one and two")).toBe(" and two");
  });

  test("extracts text from part.text when no delta", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.activeSessionId = "s1";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p2", sessionID: "s1", type: "text", text: "Content from part" } },
    });

    expect(internal.state.lastOutputAt).toBeTruthy();
  });

  test("accepts v2 message.part.delta events", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.activeSessionId = "s1";

    internal.handleSseEvent({
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "Hello delta" },
    });

    expect(internal.state.lastOutputAt).toBeTruthy();
  });

  test("ignores message updates when not busy", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "idle";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p3", type: "text" }, delta: "Should be ignored" },
    });

    expect(internal.state.lastOutputAt).toBeUndefined();
  });

  test("ignores reasoning parts", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_reasoning_1",
          type: "reasoning",
          text: "The user gave a 👌🏻 emoji which seems like an acknowledgment.",
        },
      },
    });

    await internal.outputBatcher.flushNow();

    expect(internal.state.lastOutputAt).toBeUndefined();
    expect(events.filter((event) => event.type === "stdout")).toHaveLength(0);
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("(no output)");
  });

  test("ignores text deltas that belong to known reasoning parts", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.activeSessionId = "s1";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_reasoning_delta",
          sessionID: "s1",
          messageID: "m_assistant_1",
          type: "reasoning",
          text: "The user is sending an emoji.",
        },
      },
    });
    internal.handleSseEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "s1",
        messageID: "m_assistant_1",
        partID: "p_reasoning_delta",
        field: "text",
        delta: "I should answer briefly.",
      },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_visible_answer",
          sessionID: "s1",
          messageID: "m_assistant_1",
          type: "text",
          text: "真正可发送的回复",
        },
      },
    });

    await internal.outputBatcher.flushNow();

    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join(""))
      .toBe("真正可发送的回复");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("真正可发送的回复");
  });

  test("ignores non-text message.part.delta fields", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";

    internal.handleSseEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "s1",
        messageID: "m1",
        partID: "p_reasoning_delta_1",
        field: "reasoning_content",
        delta: "I'll respond briefly to acknowledge their input.",
      },
    });

    await internal.outputBatcher.flushNow();

    expect(internal.state.lastOutputAt).toBeUndefined();
    expect(events.filter((event) => event.type === "stdout")).toHaveLength(0);
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("(no output)");
  });

  test("deduplicates accumulated message.part.updated snapshots", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.activeSessionId = "s1";

    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_text_1", sessionID: "s1", type: "text", text: "Hello" } },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_text_1", sessionID: "s1", type: "text", text: "Hello world" } },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: { part: { id: "p_text_1", sessionID: "s1", type: "text", text: "Hello world" } },
    });

    await internal.outputBatcher.flushNow();

    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join("")).toBe("Hello world");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("Hello world");
  });

  test("does not duplicate text when a delta is followed by a full snapshot", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; lastOutputAt?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "busy";
    internal.activeSessionId = "s1";

    internal.handleSseEvent({
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", partID: "p_text_2", field: "text", delta: "Hello" },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_text_2",
          sessionID: "s1",
          type: "text",
          text: "Hello world",
        },
      },
    });

    await internal.outputBatcher.flushNow();

    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join("")).toBe("Hello world");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("Hello world");
  });

  test("mirrors local user messages discovered from message events", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; origin?: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as { type: string; text?: string; origin?: string; status?: string },
      );
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.activeSessionId = "session_local_1";

    internal.handleSseEvent({
      type: "message.updated",
      properties: {
        sessionID: "session_local_1",
        info: { id: "m_user_local_1", sessionID: "session_local_1", role: "user" },
      },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_user_local_1",
          sessionID: "session_local_1",
          messageID: "m_user_local_1",
          type: "text",
          text: "hello from local opencode",
        },
      },
    });

    expect(internal.state.status).toBe("busy");
    expect(internal.state.activeTurnOrigin).toBe("local");
    expect(events.filter((event) => event.type === "mirrored_user_input")).toEqual([
      expect.objectContaining({
        text: "hello from local opencode",
        origin: "local",
      }),
    ]);
  });

  test("does not include local prompt echoes in the final reply buffer", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; origin?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; origin?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      activeSessionId: string | null;
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.state.status = "idle";
    internal.activeSessionId = "session_local_echo";

    internal.handleSseEvent({
      type: "tui.prompt.append",
      properties: { text: "我希望你是女孩" },
    });
    internal.handleSseEvent({
      type: "tui.command.execute",
      properties: { command: "prompt.submit" },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_user_local_echo",
          sessionID: "session_local_echo",
          messageID: "m_user_local_echo",
          type: "text",
          text: "我希望你是女孩",
        },
      },
    });
    internal.handleSseEvent({
      type: "message.updated",
      properties: {
        sessionID: "session_local_echo",
        info: { id: "m_user_local_echo", sessionID: "session_local_echo", role: "user" },
      },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_assistant_local_echo",
          sessionID: "session_local_echo",
          messageID: "m_assistant_local_echo",
          type: "text",
          text: "好的呀，那我就当你的贴心女孩助手。",
        },
      },
    });

    await internal.outputBatcher.flushNow();

    expect(events.filter((event) => event.type === "mirrored_user_input")).toEqual([
      expect.objectContaining({
        text: "我希望你是女孩",
        origin: "local",
      }),
    ]);
    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join(""))
      .toBe("好的呀，那我就当你的贴心女孩助手。");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("好的呀，那我就当你的贴心女孩助手。");
  });

  test("does not mirror wechat-origin user messages back to WeChat", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; origin?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; origin?: string });
    });
    const internal = adapter as unknown as {
      client: {
        session: {
          create(options?: Record<string, unknown>): Promise<unknown>;
          promptAsync(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.client = {
      session: {
        create: async () => ({
          data: createSdkSessionRecord("session_wechat_1"),
          error: undefined,
          request: {},
          response: {},
        }),
        promptAsync: async () => ({
          data: undefined,
          error: undefined,
          request: {},
          response: {},
        }),
      },
    };

    await adapter.sendInput("hello from wechat");

    internal.handleSseEvent({
      type: "message.updated",
      properties: {
        sessionID: "session_wechat_1",
        info: { id: "m_user_wechat_1", sessionID: "session_wechat_1", role: "user" },
      },
    });
    internal.handleSseEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p_user_wechat_1",
          sessionID: "session_wechat_1",
          messageID: "m_user_wechat_1",
          type: "text",
          text: "hello from wechat",
        },
      },
    });

    expect(events.filter((event) => event.type === "mirrored_user_input")).toHaveLength(0);
  });

  test("does not classify promptAsync-time WeChat echoes as local OpenCode input", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; origin?: string; status?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; origin?: string; status?: string });
    });
    const internal = adapter as unknown as {
      client: {
        session: {
          create(options?: Record<string, unknown>): Promise<unknown>;
          promptAsync(options?: Record<string, unknown>): Promise<unknown>;
        };
      };
      state: { status: string; activeTurnOrigin?: string };
      outputBatcher: { flushNow(): Promise<void>; getRecentSummary(maxLength?: number): string };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };

    internal.client = {
      session: {
        create: async () => ({
          data: createSdkSessionRecord("session_wechat_prompt_async"),
          error: undefined,
          request: {},
          response: {},
        }),
        promptAsync: async () => {
          internal.handleSseEvent({
            type: "message.part.updated",
            properties: {
              part: {
                id: "p_user_prompt_async",
                sessionID: "session_wechat_prompt_async",
                messageID: "m_user_prompt_async",
                type: "text",
                text: "hello from wechat",
              },
            },
          });
          internal.handleSseEvent({
            type: "message.updated",
            properties: {
              sessionID: "session_wechat_prompt_async",
              info: {
                id: "m_user_prompt_async",
                sessionID: "session_wechat_prompt_async",
                role: "user",
              },
            },
          });
          internal.handleSseEvent({
            type: "message.part.updated",
            properties: {
              part: {
                id: "p_assistant_prompt_async",
                sessionID: "session_wechat_prompt_async",
                messageID: "m_assistant_prompt_async",
                type: "text",
                text: "Assistant answer",
              },
            },
          });
          return {
            data: undefined,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    await adapter.sendInput("hello from wechat");
    await internal.outputBatcher.flushNow();

    expect(internal.state.status).toBe("busy");
    expect(internal.state.activeTurnOrigin).toBe("wechat");
    expect(events.filter((event) => event.type === "mirrored_user_input")).toHaveLength(0);
    expect(events.filter((event) => event.type === "stdout").map((event) => event.text).join(""))
      .toBe("Assistant answer");
    expect(internal.outputBatcher.getRecentSummary(500)).toBe("Assistant answer");
  });
});

/* ------------------------------------------------------------------ */
/*  Working notice                                                     */
/* ------------------------------------------------------------------ */

describe("OpenCode working notice", () => {
  test("emits a single notice for long-running WeChat turns", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as { type: string; text?: string; level?: string });
    });
    const internal = adapter as unknown as {
      state: { status: string; activeTurnOrigin?: string };
      hasAcceptedInput: boolean;
      pendingPermission: unknown;
      currentPreview: string;
      workingNoticeDelayMs: number;
      armWechatWorkingNotice(): void;
    };

    internal.workingNoticeDelayMs = 5;
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Review the failing tests";
    internal.pendingPermission = null;

    // The working notice is armed by sendInput(), simulate it directly.
    internal.armWechatWorkingNotice();

    await wait(20);

    const noticeEvents = events.filter((e) => e.type === "notice");
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]).toMatchObject({
      level: "info",
      text: "OpenCode is still working on:\nReview the failing tests",
    });

    await wait(20);
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  dispose                                                            */
/* ------------------------------------------------------------------ */

describe("OpenCode dispose", () => {
  test("transitions to stopped and clears state", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      state: { status: string; pendingApproval: unknown; pendingApprovalOrigin?: string };
      shuttingDown: boolean;
      pendingPermission: unknown;
    };

    internal.state.status = "busy";

    await adapter.dispose();

    expect(adapter.getState().status).toBe("stopped");
    expect(internal.shuttingDown).toBe(true);
    expect(internal.pendingPermission).toBeNull();
    expect(adapter.getState().pendingApproval).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  WeChat session resume                                              */
/* ------------------------------------------------------------------ */

describe("OpenCode WeChat session resume", () => {
  test("lists recent root sessions with explicit directory routing", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const listParameters: Record<string, unknown>[] = [];
    const older = createSdkSessionRecord("ses_older", { title: "Older" });
    older.time.updated = 1_000;
    const newer = createSdkSessionRecord("ses_newer", { title: "Newer" });
    newer.time.updated = 2_000;
    const child = {
      ...createSdkSessionRecord("ses_child"),
      parentID: "ses_newer",
    };
    const internal = adapter as unknown as {
      client: unknown;
    };
    internal.client = {
      session: {
        list: async (parameters: Record<string, unknown>) => {
          listParameters.push(parameters);
          return {
            data: [older, child, newer],
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    const candidates = await adapter.listResumeSessions(8);

    expect(listParameters).toEqual([
      {
        directory: process.cwd(),
        workspace: undefined,
        roots: true,
        limit: 8,
      },
    ]);
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual([
      "ses_newer",
      "ses_older",
    ]);
  });

  test("reports session listing failures instead of returning an empty list", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const internal = adapter as unknown as { client: unknown };
    internal.client = {
      session: {
        list: async () => ({
          data: undefined,
          error: new Error("authentication failed"),
          request: {},
          response: {},
        }),
      },
    };

    await expect(adapter.listResumeSessions()).rejects.toThrow(
      "Failed to list OpenCode sessions: SDK error: authentication failed",
    );
  });

  test("rejects resume while the active OpenCode turn is busy", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const internal = adapter as unknown as {
      client: unknown;
      state: { status: string };
    };
    internal.client = {};
    internal.state.status = "busy";

    await expect(adapter.resumeSession("ses_target")).rejects.toThrow(
      "OpenCode is still working",
    );
  });

  test("requires pending approvals and questions to be settled before resume", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const internal = adapter as unknown as {
      client: unknown;
      state: { status: string };
      pendingPermission: unknown;
      pendingQuestion: unknown;
    };
    internal.client = {};
    internal.state.status = "awaiting_approval";
    internal.pendingPermission = {};

    await expect(adapter.resumeSession("ses_target")).rejects.toThrow(
      "An OpenCode approval request is pending",
    );

    internal.pendingPermission = null;
    internal.pendingQuestion = {};
    internal.state.status = "awaiting_input";
    await expect(adapter.resumeSession("ses_target")).rejects.toThrow(
      "OpenCode is waiting for user input",
    );
  });

  test("checks target status and commits shared state only after visible selection", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const selectedSessionIds: string[] = [];
    const events: Array<{ type: string; sessionId?: string; reason?: string }> = [];
    adapter.setEventSink((event) => {
      events.push(event as { type: string; sessionId?: string; reason?: string });
    });
    const target = createSdkSessionRecord("ses_target");
    const internal = adapter as unknown as {
      client: unknown;
      activeSessionId: string | null;
      tuiRouteSocket: unknown;
      state: {
        status: string;
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
      };
      handleTuiRouteFrame(frame: Record<string, unknown>): void;
    };
    internal.activeSessionId = "ses_current";
    internal.state.status = "idle";
    internal.state.sharedSessionId = "ses_current";
    internal.state.sharedThreadId = "ses_current";
    internal.state.activeRuntimeSessionId = "ses_current";
    internal.tuiRouteSocket = {};
    internal.client = {
      session: {
        get: async () => ({
          data: target,
          error: undefined,
          request: {},
          response: {},
        }),
        status: async () => ({
          data: { ses_target: { type: "idle" } },
          error: undefined,
          request: {},
          response: {},
        }),
      },
      tui: {
        selectSession: async (parameters: { sessionID?: string }) => {
          selectedSessionIds.push(parameters.sessionID ?? "");
          expect(internal.state.sharedSessionId).toBe("ses_current");
          internal.handleTuiRouteFrame({
            type: "route_state",
            sessionId: parameters.sessionID,
          });
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    await adapter.resumeSession("ses_target");

    expect(selectedSessionIds).toEqual(["ses_target"]);
    expect(adapter.getState()).toEqual(
      expect.objectContaining({
        status: "idle",
        sharedSessionId: "ses_target",
        activeRuntimeSessionId: "ses_target",
      }),
    );
    expect(events.filter((event) => event.type === "session_switched")).toEqual([
      expect.objectContaining({
        sessionId: "ses_target",
        reason: "wechat_resume",
      }),
    ]);
  });

  test("keeps the current session when visible selection fails", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const target = createSdkSessionRecord("ses_target");
    const internal = adapter as unknown as {
      client: unknown;
      activeSessionId: string | null;
      state: {
        status: string;
        sharedSessionId?: string;
        sharedThreadId?: string;
      };
      selectVisibleSessionForResume: () => Promise<void>;
    };
    internal.activeSessionId = "ses_current";
    internal.state.status = "idle";
    internal.state.sharedSessionId = "ses_current";
    internal.state.sharedThreadId = "ses_current";
    internal.client = {
      session: {
        get: async () => ({
          data: target,
          error: undefined,
          request: {},
          response: {},
        }),
        status: async () => ({
          data: { ses_target: { type: "idle" } },
          error: undefined,
          request: {},
          response: {},
        }),
      },
    };
    internal.selectVisibleSessionForResume = async () => {
      throw new Error("visible selection failed");
    };

    await expect(adapter.resumeSession("ses_target")).rejects.toThrow(
      "visible selection failed",
    );
    expect(internal.activeSessionId).toBe("ses_current");
    expect(internal.state.sharedSessionId).toBe("ses_current");
  });

  test("rejects a target session that is still retrying", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const target = createSdkSessionRecord("ses_target");
    const internal = adapter as unknown as {
      client: unknown;
      state: { status: string };
    };
    internal.state.status = "idle";
    internal.client = {
      session: {
        get: async () => ({
          data: target,
          error: undefined,
          request: {},
          response: {},
        }),
        status: async () => ({
          data: { ses_target: { type: "retry", attempt: 2 } },
          error: undefined,
          request: {},
          response: {},
        }),
      },
    };

    await expect(adapter.resumeSession("ses_target")).rejects.toThrow(
      "is still retrying",
    );
  });

  test("clears stale shared state when the active session is deleted", () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const internal = adapter as unknown as {
      activeSessionId: string | null;
      state: {
        status: string;
        sharedSessionId?: string;
        sharedThreadId?: string;
        activeRuntimeSessionId?: string;
      };
      handleSseEvent(event: { type: string; properties?: unknown }): void;
    };
    internal.activeSessionId = "ses_deleted";
    internal.state.status = "idle";
    internal.state.sharedSessionId = "ses_deleted";
    internal.state.sharedThreadId = "ses_deleted";
    internal.state.activeRuntimeSessionId = "ses_deleted";

    internal.handleSseEvent({
      type: "session.deleted",
      properties: { info: { id: "ses_deleted" } },
    });

    expect(internal.activeSessionId).toBeNull();
    expect(internal.state.sharedSessionId).toBeUndefined();
    expect(internal.state.sharedThreadId).toBeUndefined();
    expect(internal.state.activeRuntimeSessionId).toBeUndefined();
  });

  test("aborts a WeChat turn and follows a local visible route switch", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const events: Array<{ type: string; message?: string; sessionId?: string; source?: string }> = [];
    const abortedSessionIds: string[] = [];
    adapter.setEventSink((event) => {
      events.push(
        event as unknown as {
          type: string;
          message?: string;
          sessionId?: string;
          source?: string;
        },
      );
    });
    const target = createSdkSessionRecord("ses_local_target");
    const internal = adapter as unknown as {
      client: unknown;
      activeSessionId: string | null;
      hasAcceptedInput: boolean;
      currentPreview: string;
      state: {
        status: string;
        activeTurnOrigin?: string;
        activeTurnId?: string;
        sharedSessionId?: string;
        sharedThreadId?: string;
      };
      handleTuiRouteFrame(frame: Record<string, unknown>): void;
    };
    internal.activeSessionId = "ses_wechat_old";
    internal.hasAcceptedInput = true;
    internal.currentPreview = "Old WeChat task";
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";
    internal.state.activeTurnId = "turn_old";
    internal.state.sharedSessionId = "ses_wechat_old";
    internal.state.sharedThreadId = "ses_wechat_old";
    internal.client = {
      session: {
        get: async () => ({
          data: target,
          error: undefined,
          request: {},
          response: {},
        }),
        abort: async (parameters: { sessionID: string }) => {
          abortedSessionIds.push(parameters.sessionID);
          return {
            data: true,
            error: undefined,
            request: {},
            response: {},
          };
        },
      },
    };

    internal.handleTuiRouteFrame({
      type: "route_state",
      sessionId: "ses_local_target",
    });
    await wait(0);

    expect(abortedSessionIds).toEqual(["ses_wechat_old"]);
    expect(internal.activeSessionId).toBe("ses_local_target");
    expect(internal.state.status).toBe("idle");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_failed",
        message: expect.stringContaining("local OpenCode terminal switched sessions"),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session_switched",
        sessionId: "ses_local_target",
        source: "local",
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Shared utilities                                                   */
/* ------------------------------------------------------------------ */

describe("OpenCode shared utilities", () => {
  test("resolveDefaultAdapterCommand returns opencode for opencode kind", () => {
    expect(resolveDefaultAdapterCommand("opencode", { platform: "win32" })).toBe("opencode");
    expect(resolveDefaultAdapterCommand("opencode", { platform: "linux" })).toBe("opencode");
    expect(resolveDefaultAdapterCommand("opencode", { platform: "darwin" })).toBe("opencode");
  });

  test("getLocalCompanionCommandName returns wechat-opencode for opencode", () => {
    expect(getLocalCompanionCommandName("opencode")).toBe("wechat-opencode");
  });
});

/* ------------------------------------------------------------------ */
/*  Adapter-aware message formatting                                   */
/* ------------------------------------------------------------------ */

describe("OpenCode message formatting", () => {
  test("formats mirrored OpenCode input without Claude/Codex wording", () => {
    expect(formatMirroredUserInputMessage("opencode", "Review the bridge tests")).toContain(
      "Local OpenCode input",
    );
  });

  test("formats final reply and failure messages by adapter", () => {
    expect(formatFinalReplyMessage("opencode", "Done")).toBe("Done");
    expect(formatTaskFailedMessage("opencode", "Boom")).toBe("OpenCode task failed:\nBoom");
  });

  test("formats OpenCode session resume list with session wording", () => {
    const output = formatResumeSessionList({
      adapter: "opencode",
      candidates: [
        {
          sessionId: "session_1",
          title: "Continue the OpenCode bridge refactor",
          lastUpdatedAt: "2026-03-28T10:00:00.000Z",
        },
      ],
      currentSessionId: "session_1",
    });

    expect(output).toContain("Recent OpenCode sessions:");
    expect(output).toContain("session_1");
    expect(output).toContain("[current]");
  });
});
