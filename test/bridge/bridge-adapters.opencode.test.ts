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
      "--theme",
      "system",
    ]);
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

  test("starts both local and global sync SSE loops", async () => {
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
      global: { syncEvent: {} },
    };
    internal.runSseLoop = async (streamName: string) => {
      subscribedStreams.push(streamName);
    };

    internal.startSseListener();
    await internal.sseLoopPromise;

    expect(subscribedStreams).toEqual(["event", "global-event", "global-sync"]);
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

  test("drives the visible TUI when a local session switch becomes authoritative", async () => {
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

    expect(selectSessionCalls).toEqual([
      expect.objectContaining({
        directory: process.cwd(),
        sessionID: "session_selected_local",
        workspace: "workspace_1",
      }),
    ]);
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
/*  permission.updated handling                                        */
/* ------------------------------------------------------------------ */

describe("OpenCode permission.updated handling", () => {
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

    // Real SDK: EventPermissionUpdated = { type: "permission.updated", properties: Permission }
    // Permission = { id, sessionID, title, type, metadata, ... }
    internal.handleSseEvent({
      type: "permission.updated",
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
      type: "permission.updated",
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
      type: "permission.updated",
      properties: { type: "bash" },
    });

    expect(events.filter((e) => e.type === "approval_required")).toHaveLength(0);
    expect(internal.pendingPermission).toBeNull();
    expect(internal.state.status).toBe("busy");
  });

  test("works with minimal permission properties", () => {
    const { events, internal } = createPermissionAdapter();

    internal.handleSseEvent({
      type: "permission.updated",
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
    expect(internal.shouldHandleSseEvent(syncEvent!, "global-sync")).toBe(true);
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
