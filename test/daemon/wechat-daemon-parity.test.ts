// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
//
// Locks the daemon behaviors that the standalone bridge does differently and
// that the daemon keeps once the standalone bridge is removed. Behaviors the
// merge still has to change are listed as test.todo at the bottom.
import { setLocale } from "../../src/i18n/index.ts";
import { beforeEach, describe, expect, test } from "bun:test";

import type {
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
} from "../../src/bridge/bridge-types.ts";
import type { DaemonAdapterKind } from "../../src/daemon/daemon-link.ts";
import {
  BridgeDaemon,
  type BridgeDaemonDeps,
} from "../../src/daemon/wechat-daemon.ts";
import type { ChannelConversationRef } from "../../src/core/channel-types.ts";
import type { TelegramTransport } from "../../src/channels/telegram/telegram-transport.ts";
import type { PendingMessageStore } from "../../src/core/pending-message-store.ts";
import type {
  BridgeInboundMessage,
  WeChatTransport,
} from "../../src/wechat/wechat-transport.ts";
import type { SlotSessionRecord, SlotSessionStore } from "../../src/daemon/slot-session-store.ts";
import { createMemorySlotPins } from "../../src/daemon/slot-pins.ts";

beforeEach(() => setLocale("en"));

const TEST_CWD = "/tmp/daemon-parity";
const OPERATOR_ID = "operator-001";

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeWeChatTransport {
  readonly sent: { recipientId: string; text: string }[] = [];

  async sendText(recipientId: string, text: string): Promise<void> {
    this.sent.push({ recipientId, text });
  }

  async fetchTypingTicket(): Promise<string> {
    return "";
  }
}

class FakePendingStore {
  list(): [] {
    return [];
  }
  enqueue(): null {
    return null;
  }
  remove(): boolean {
    return false;
  }
}

class FakeRuntime implements BridgeAdapter {
  state: BridgeAdapterState;
  lifecycle?: string;
  attachThread?: string;
  readonly inputs: string[] = [];
  readonly approvals: Array<"confirm" | "deny"> = [];
  readonly answers: Record<string, string[]>[] = [];
  private sink: ((event: BridgeEvent) => void) | null = null;

  constructor(adapter: DaemonAdapterKind, cwd: string, command: string) {
    this.state = {
      kind: adapter,
      status: "idle",
      cwd,
      command,
      // A visible Codex client reports its thread, so ensureSlot does not wait.
      ...(adapter === "codex"
        ? { sharedThreadId: "thread-visible", lastThreadSwitchSource: "local" as const }
        : {}),
    };
  }

  emit(event: BridgeEvent): void {
    this.sink?.(event);
  }

  setEventSink(sink: (event: BridgeEvent) => void): void {
    this.sink = sink;
  }

  async start(): Promise<void> {}

  async sendInput(text: string): Promise<void> {
    this.inputs.push(text);
  }

  async listResumeSessions(): Promise<[]> {
    return [];
  }

  async resumeSession(): Promise<void> {}

  async interrupt(): Promise<boolean> {
    return true;
  }

  async reset(): Promise<void> {}

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    this.approvals.push(action);
    this.state = { ...this.state, pendingApproval: null, status: "busy" };
    return true;
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    this.answers.push(answers);
    this.state = { ...this.state, pendingUserInput: null, status: "busy" };
    return true;
  }

  async dispose(): Promise<void> {}

  getState(): BridgeAdapterState {
    return this.state;
  }
}

class MemorySessionStore implements SlotSessionStore {
  readonly records = new Map<string, SlotSessionRecord>();

  read(cwd: string, adapter: DaemonAdapterKind): SlotSessionRecord | null {
    return this.records.get(`${cwd}|${adapter}`) ?? null;
  }

  write(cwd: string, adapter: DaemonAdapterKind, record: SlotSessionRecord): void {
    this.records.set(`${cwd}|${adapter}`, record);
  }
}

function windowKey(cwd: string, adapter: DaemonAdapterKind, instance = 1): string {
  return instance > 1 ? `${cwd}|${adapter}-${instance}` : `${cwd}|${adapter}`;
}

class Env {
  readonly wechat = new FakeWeChatTransport();
  readonly created: FakeRuntime[] = [];
  readonly logs: string[] = [];
  readonly sessions = new MemorySessionStore();
  readonly restoredWith: Array<string | undefined> = [];
  readonly opened: { cwd: string; adapter: DaemonAdapterKind; title?: string }[] = [];
  /** Visible windows that are already running, as `cwd|adapter` (`cwd|adapter-2` for numbered ones). */
  readonly alive = new Set<string>();
  /** Treat every visible window as already running (the default). */
  allAlive = true;

  readonly deps: BridgeDaemonDeps = {
    createRuntime: (params) => {
      const runtime = new FakeRuntime(params.kind, params.cwd, params.command);
      runtime.lifecycle = params.lifecycle;
      runtime.attachThread = params.codexAttachDaemon ? params.codexAttachThreadId ?? "discovered" : undefined;
      if (runtime.attachThread) {
        runtime.state = { ...runtime.state, sharedThreadId: runtime.attachThread };
      }
      this.restoredWith.push(params.initialSharedSessionId);
      this.created.push(runtime);
      return runtime;
    },
    openVisibleClient: (params) => {
      this.opened.push({ cwd: params.cwd, adapter: params.adapter, title: params.title });
      this.alive.add(windowKey(params.cwd, params.adapter, params.instance));
      return { command: "fake-visible-client", args: [] };
    },
    isVisibleClientAlive: (cwd, adapter, instance) =>
      this.allAlive || this.alive.has(windowKey(cwd, adapter, instance)),
    daemonLog: (message) => {
      this.logs.push(message);
    },
    pendingMessages:
      new FakePendingStore() as unknown as PendingMessageStore,
    visibleClientConnectTimeoutMs: 50,
    fatalNoticeGraceMs: 0,
    exitProcess: (code) => {
      this.exitCodes.push(code);
    },
    slotSessions: this.sessions,
    // Auto sessions register into the pin store; keep each env's store private
    // so parallel test files never share ~/.cli-bridge/pins.json.
    slotPins: createMemorySlotPins(),
  };
  readonly exitCodes: number[] = [];

  buildDaemon(): BridgeDaemon {
    return new BridgeDaemon({
      cwd: TEST_CWD,
      authorizedUserId: OPERATOR_ID,
      transport: this.wechat as unknown as WeChatTransport,
      channelId: "wechat",
      deps: this.deps,
    });
  }

  runtimeIn(cwd: string, adapter: DaemonAdapterKind): FakeRuntime {
    const runtime = this.created.find((entry) =>
      entry.state.cwd === cwd && entry.state.kind === adapter);
    if (!runtime) {
      throw new Error(`no ${adapter} runtime in ${cwd}`);
    }
    return runtime;
  }

  latest(): FakeRuntime {
    const runtime = this.created.at(-1);
    if (!runtime) {
      throw new Error("no runtime was created");
    }
    return runtime;
  }

  texts(): string[] {
    return this.wechat.sent.map((message) => message.text);
  }
}

function inbound(text: string, senderId = OPERATOR_ID): BridgeInboundMessage {
  return {
    senderId,
    sender: senderId,
    sessionId: senderId,
    text,
    attachments: [],
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  };
}

async function send(daemon: BridgeDaemon, text: string, senderId?: string): Promise<void> {
  await (daemon as unknown as {
    handleInboundMessage(message: BridgeInboundMessage): Promise<void>;
  }).handleInboundMessage(inbound(text, senderId));
}

function event<T extends BridgeEvent["type"]>(
  type: T,
  fields: Omit<Extract<BridgeEvent, { type: T }>, "type" | "timestamp">,
): BridgeEvent {
  return { type, timestamp: new Date().toISOString(), ...fields } as BridgeEvent;
}

describe("daemon behaviors kept after the standalone merge", () => {
  test("a single bridge sends replies bare; several CLIs prefix them with [adapter]", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    const claude = env.latest();
    await send(daemon, "fix the failing test");
    env.wechat.sent.length = 0;

    claude.emit(event("final_reply", { text: "Tests pass now." }));
    await tick(20);
    expect(env.texts()).toEqual(["Tests pass now."]);

    await send(daemon, "/codex");
    env.wechat.sent.length = 0;
    claude.emit(event("final_reply", { text: "Still green." }));
    await tick(20);
    expect(env.texts()).toEqual(["[claude]\nStill green."]);
  });

  test("disposes a slot after a fatal error and rebuilds it on the next switch", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    const first = env.latest();

    first.emit(event("fatal_error", { message: "claude exited" }));
    await tick(20);
    env.wechat.sent.length = 0;

    await send(daemon, "are you there?");
    expect(first.inputs).toHaveLength(0);
    expect(env.texts().at(-1)).toContain("No active terminal is selected.");

    await send(daemon, "/claude");
    expect(env.created).toHaveLength(2);
    expect(env.latest()).not.toBe(first);
  });

  test("keeps a persistent daemon running when a slot requests shutdown", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");

    env.latest().emit(event("shutdown_requested", {
      reason: "companion_closed",
      message: "companion exited",
    }));
    await tick(20);

    const internal = daemon as unknown as {
      shutdownPromise: Promise<void> | null;
      slots: Map<DaemonAdapterKind, unknown>;
    };
    expect(internal.shutdownPromise).toBeNull();
    expect(internal.slots.has("claude")).toBe(true);
  });

  test("answers an unauthorized sender without dispatching", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    env.wechat.sent.length = 0;

    await send(daemon, "run rm -rf /", "stranger");

    expect(env.latest().inputs).toHaveLength(0);
    expect(env.wechat.sent).toHaveLength(1);
    expect(env.wechat.sent[0]!.recipientId).toBe("stranger");
  });
});

const OTHER_CWD = "/tmp/other-app";

async function openWorkspaceSlot(
  daemon: BridgeDaemon,
  cwd: string,
  adapter: DaemonAdapterKind,
): Promise<void> {
  await daemon.handleDaemonRequest({ command: "ensure_slot", adapter, cwd });
}

const approvalRequest = {
  source: "cli" as const,
  summary: "Delete the build directory?",
  commandPreview: "rm -rf build",
  requestId: "approval-1",
};

const questionRequest = {
  requestId: "question-1",
  summary: "Which environment?",
  questions: [
    { id: "env", header: "Environment", question: "Which environment?", isOther: true, isSecret: false },
  ],
};

describe("multi-directory daemon", () => {
  test("a launcher in another directory adds a slot there and announces the multi-directory mode", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    env.wechat.sent.length = 0;

    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");

    expect(env.runtimeIn(OTHER_CWD, "codex")).toBeDefined();
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
    expect(daemon.getStatus().activeAdapter).toBe("claude");
    expect(env.texts().at(-1)).toContain("other-app/codex joined");
    expect(env.texts().at(-1)).toContain("/cd");
  });

  test("/cd lists directories and switches by number or name", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");
    env.wechat.sent.length = 0;

    await send(daemon, "/cd");
    expect(env.texts().at(-1)).toContain("1. daemon-parity (claude) ← current");
    expect(env.texts().at(-1)).toContain("2. other-app (codex)");

    await send(daemon, "/cd 2");
    expect(daemon.getStatus().cwd).toBe(OTHER_CWD);
    expect(daemon.getStatus().activeAdapter).toBe("codex");

    await send(daemon, "/cd daemon-parity");
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
    expect(daemon.getStatus().activeAdapter).toBe("claude");
  });

  test("/cd refuses directories that are not open on this computer", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");

    await send(daemon, "/cd /etc");

    expect(env.texts().at(-1)).toContain("No directory matches /etc");
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
    expect(env.created).toHaveLength(2);
  });

  test("/cd is not offered before the bridge spans several directories", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");

    await send(daemon, "/cd");

    expect(env.texts().at(-1)).toContain("/cd works only once the bridge spans several directories");
  });

  test("/cd asks for a number when two directories share a name", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await openWorkspaceSlot(daemon, "/tmp/a/app", "claude");
    await openWorkspaceSlot(daemon, "/tmp/b/app", "claude");

    await send(daemon, "/cd app");

    expect(env.texts().at(-1)).toContain("Several directories are named app");
    // The first window became current, as nothing else was.
    expect(daemon.getStatus().cwd).toBe("/tmp/a/app");
  });

  test("output from another directory is prefixed with [directory/adapter]", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");
    env.wechat.sent.length = 0;

    env.runtimeIn(OTHER_CWD, "codex").emit(event("final_reply", { text: "Build finished." }));
    env.runtimeIn(TEST_CWD, "claude").emit(event("final_reply", { text: "Tests pass." }));
    await tick(20);

    // With two workspaces listed, every message names its directory.
    expect(env.texts()).toEqual([
      "[other-app/codex]\nBuild finished.",
      "[daemon-parity/claude]\nTests pass.",
    ]);
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
  });

  test("/confirm lists a request waiting in another directory and /confirm <n> resolves it", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");
    const codex = env.runtimeIn(OTHER_CWD, "codex");
    codex.state = { ...codex.state, pendingApproval: approvalRequest, status: "awaiting_approval" };
    codex.emit(event("approval_required", { request: approvalRequest }));
    await tick(20);
    env.wechat.sent.length = 0;

    await send(daemon, "/confirm");
    expect(codex.approvals).toEqual([]);
    expect(env.texts().at(-1)).toContain("1. other-app/codex: rm -rf build");

    await send(daemon, "/confirm 2");
    expect(env.texts().at(-1)).toContain("no pending approval numbered 2");

    await send(daemon, "/confirm 1");
    expect(codex.approvals).toEqual(["confirm"]);
    expect(env.texts().at(-1)).toContain("[other-app/codex]");
  });

  test("a legacy six-digit approval code still confirms the current request", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    const claude = env.latest();
    claude.state = { ...claude.state, pendingApproval: approvalRequest, status: "awaiting_approval" };
    claude.emit(event("approval_required", { request: approvalRequest }));
    await tick(20);

    await send(daemon, "/confirm 123456");

    expect(claude.approvals).toEqual(["confirm"]);
  });

  test("/answer #<n> answers a question waiting in another directory", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/codex");
    await openWorkspaceSlot(daemon, OTHER_CWD, "claude");
    const claude = env.runtimeIn(OTHER_CWD, "claude");
    claude.state = { ...claude.state, pendingUserInput: questionRequest, status: "awaiting_input" };
    claude.emit(event("user_input_required", { request: questionRequest }));
    await tick(20);
    env.wechat.sent.length = 0;

    await send(daemon, "/answer staging");
    expect(claude.answers).toEqual([]);
    expect(env.texts().at(-1)).toContain("#1 other-app/claude: Which environment?");

    await send(daemon, "/answer #1 staging");
    expect(claude.answers).toEqual([{ env: ["staging"] }]);
  });

  test("approvals elsewhere can be resolved even with no current terminal", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");
    const codex = env.runtimeIn(OTHER_CWD, "codex");
    codex.state = { ...codex.state, pendingApproval: approvalRequest, status: "awaiting_approval" };
    codex.emit(event("approval_required", { request: approvalRequest }));
    await tick(20);

    await send(daemon, "/deny 1");

    expect(codex.approvals).toEqual(["deny"]);
  });

  test("/all only reaches the current directory", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await openWorkspaceSlot(daemon, OTHER_CWD, "claude");

    await send(daemon, "/all compare the two plans");

    expect(env.runtimeIn(TEST_CWD, "claude").inputs.at(-1)).toContain("compare the two plans");
    expect(env.runtimeIn(OTHER_CWD, "claude").inputs).toHaveLength(0);
  });

  test("a directory disappears after its last slot dies and the current one falls back", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");
    await send(daemon, "/cd other-app");
    expect(daemon.getStatus().cwd).toBe(OTHER_CWD);

    env.runtimeIn(OTHER_CWD, "codex").emit(event("fatal_error", { message: "codex exited" }));
    await tick(20);

    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
    expect(daemon.getStatus().workspaces).toBeUndefined();
  });

  test("queues WeChat input during a local Codex turn and drains it afterwards", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/codex");
    const codex = env.latest();
    codex.state = { ...codex.state, status: "busy", activeTurnOrigin: "local", activeTurnId: "local-1" };
    env.wechat.sent.length = 0;

    await send(daemon, "also update the README");
    expect(codex.inputs).toHaveLength(0);
    expect(env.texts().at(-1)).toContain("Queued for delivery");

    codex.state = { ...codex.state, status: "idle", activeTurnOrigin: undefined, activeTurnId: undefined };
    codex.emit(event("task_complete", {}));
    await tick(20);

    expect(codex.inputs.at(-1)).toContain("also update the README");
  });
});

describe("visibility fixes after the first field test", () => {
  test("a remote switch opens the window in the current directory", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await send(daemon, "/codex");
    await openWorkspaceSlot(daemon, OTHER_CWD, "pi");
    env.alive.add(`${OTHER_CWD}|pi`);
    await send(daemon, "/cd other-app");
    env.wechat.sent.length = 0;

    await send(daemon, "/codex");

    expect(env.opened.filter((entry) => entry.cwd === OTHER_CWD && entry.adapter === "codex"))
      .toHaveLength(1);
    expect(daemon.getStatus().cwd).toBe(OTHER_CWD);
    expect(daemon.getStatus().activeAdapter).toBe("codex");
  });

  test("a remote switch still opens a window in the home directory, titled with it", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();

    await send(daemon, "/claude");

    expect(env.opened).toEqual([
      { cwd: TEST_CWD, adapter: "claude", title: "wechat-claude · daemon-parity" },
    ]);
    expect(env.texts()).toContain("Opening claude. Please wait…");
  });

  test("switch replies name the directory once several are open", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");

    await send(daemon, "/claude");

    expect(env.texts().at(-1)).toContain("Active terminal: daemon-parity/claude.");
  });

  test("the thread a new Codex window opens is not announced; later switches are", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/codex");
    const codex = env.latest();
    env.wechat.sent.length = 0;

    codex.emit(event("thread_switched", { threadId: "thread-1", source: "local", reason: "local_follow" }));
    await tick(20);
    expect(env.wechat.sent).toHaveLength(0);

    codex.emit(event("thread_switched", { threadId: "thread-2", source: "local", reason: "local_follow" }));
    await tick(20);
    expect(env.wechat.sent).toHaveLength(1);
  });

  test("a CLI exiting while the daemon shuts down is not reported as an error", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    env.wechat.sent.length = 0;

    env.latest().emit(event("fatal_error", { message: "app-server exited with code 0" }));
    await daemon.shutdown();

    expect(env.wechat.sent).toHaveLength(0);
    expect(env.logs).toContain("fatal_error_notice_skipped: adapter=claude reason=shutdown");
  });

  test("control commands are logged without prompt or answer text", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");

    await send(daemon, "/cd 1");
    await send(daemon, "/answer secret-value");
    await send(daemon, "plain prompt text");

    expect(env.logs).toContain("inbound_command: /cd 1");
    expect(env.logs).toContain("inbound_command: /answer");
    expect(env.logs.some((line) => line.includes("secret-value"))).toBe(false);
    expect(env.logs.some((line) => line.startsWith("inbound_command:") && line.includes("plain prompt"))).toBe(false);
  });
});

async function launcherSlot(
  daemon: BridgeDaemon,
  cwd: string,
  adapter: DaemonAdapterKind,
): Promise<Record<string, unknown>> {
  return await daemon.handleDaemonRequest({
    command: "ensure_slot",
    adapter,
    cwd,
    openVisible: false,
    sessionStartMode: "new",
    boundToWindow: true,
  }) as Record<string, unknown>;
}

function windowClosed(runtime: FakeRuntime): void {
  runtime.emit(event("shutdown_requested", {
    reason: "companion_closed",
    message: "companion closed",
  }));
}

describe("one engine, single-bridge and multi-CLI modes", () => {
  test("a launcher's slot is bound to its window and needs no window from the daemon", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();

    const claim = await launcherSlot(daemon, TEST_CWD, "pi");

    expect(claim.activated).toBe(true);
    expect(env.opened).toEqual([]);
    expect(env.latest().lifecycle).toBe("companion_bound");
    expect(daemon.getStatus().activeAdapter).toBe("pi");
  });

  test("an ephemeral daemon exits once the last window closes", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    daemon.setEphemeral(true);
    await launcherSlot(daemon, TEST_CWD, "pi");
    await launcherSlot(daemon, OTHER_CWD, "codex");

    windowClosed(env.runtimeIn(TEST_CWD, "pi"));
    await tick(20);
    expect(env.exitCodes).toEqual([]);
    expect(daemon.getStatus().slots.map((slot) => slot.adapter)).toEqual(["codex"]);

    windowClosed(env.runtimeIn(OTHER_CWD, "codex"));
    await tick(20);
    expect(env.exitCodes).toEqual([0]);
    expect(env.logs).toContain("ephemeral_idle_exit: no slot left");
  });

  test("in single-bridge mode a remote switch opens a window-bound CLI in the home directory", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    daemon.setEphemeral(true);
    await launcherSlot(daemon, TEST_CWD, "pi");

    await send(daemon, "/codex");

    expect(env.opened.map((entry) => `${entry.cwd}|${entry.adapter}`)).toEqual([`${TEST_CWD}|codex`]);
    expect(env.runtimeIn(TEST_CWD, "codex").lifecycle).toBe("companion_bound");
  });

  test("a persistent daemon keeps running after a launcher window closes", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, OTHER_CWD, "codex");

    windowClosed(env.runtimeIn(OTHER_CWD, "codex"));
    await tick(20);

    expect(env.exitCodes).toEqual([]);
    expect(daemon.getStatus().slots).toEqual([]);
    expect(env.logs.some((line) => line.startsWith("slot_released: adapter=codex"))).toBe(true);
  });

  test("promote keeps an ephemeral daemon running; once empty it opens windows in the new home", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    daemon.setEphemeral(true);
    await launcherSlot(daemon, TEST_CWD, "pi");

    const promoted = await daemon.handleDaemonRequest({ command: "promote", cwd: OTHER_CWD });
    windowClosed(env.runtimeIn(TEST_CWD, "pi"));
    await tick(20);

    expect(promoted).toEqual({ pid: process.pid, wasEphemeral: true });
    expect(env.exitCodes).toEqual([]);
    expect(daemon.getStatus().mode).toBe("none");
    await send(daemon, "/claude");
    expect(env.opened.map((entry) => `${entry.cwd}|${entry.adapter}`)).toEqual([`${OTHER_CWD}|claude`]);
  });

  test("a closed window ends its slot even when the adapter never reports it (Codex)", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    daemon.setEphemeral(true);
    await launcherSlot(daemon, TEST_CWD, "codex");
    const slots = (daemon as unknown as {
      slotManager: { releaseClosedWindows(nowMs?: number): void };
    }).slotManager;

    env.alive.add(`${TEST_CWD}|codex`);
    slots.releaseClosedWindows();
    env.alive.delete(`${TEST_CWD}|codex`);
    slots.releaseClosedWindows();
    expect(daemon.getStatus().slots).toHaveLength(1);
    slots.releaseClosedWindows();
    await tick(20);

    expect(daemon.getStatus().slots).toEqual([]);
    expect(env.exitCodes).toEqual([0]);
  });

  test("a launcher slot whose window never connects is released after the grace period", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, OTHER_CWD, "claude");
    const slots = (daemon as unknown as {
      slotManager: { releaseClosedWindows(nowMs?: number): void };
    }).slotManager;

    slots.releaseClosedWindows(Date.now() + 10_000);
    expect(daemon.getStatus().slots).toHaveLength(1);
    slots.releaseClosedWindows(Date.now() + 61_000);

    expect(daemon.getStatus().slots).toEqual([]);
    expect(env.logs.some((line) => line.startsWith("window_never_connected: adapter=claude"))).toBe(true);
  });

  test("a second launcher of the same CLI opens a numbered instance without resetting the first", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, TEST_CWD, "claude");
    env.alive.add(`${TEST_CWD}|claude`);
    const claude = env.latest();
    env.wechat.sent.length = 0;

    const claim = await launcherSlot(daemon, TEST_CWD, "claude");

    expect(claim.instance).toBe(2);
    expect(env.created).toHaveLength(2);
    expect(claude.inputs).toEqual([]);
    expect(env.texts().at(-1)).toContain("A second claude opened");
  });
});

describe("progressive bridge modes", () => {
  const status = (daemon: BridgeDaemon) =>
    (daemon as unknown as { slotManager: { mode: { kind: string } } }).slotManager.mode.kind;

  test("the first window is a clean single bridge", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    expect(status(daemon)).toBe("none");

    await launcherSlot(daemon, TEST_CWD, "pi");

    expect(status(daemon)).toBe("single");
    expect(env.texts().some((text) => text.includes("joined") || text.includes("opened"))).toBe(false);
  });

  test("another CLI type in the same directory moves to multi-CLI mode, which refuses a repeat", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, TEST_CWD, "pi");
    env.alive.add(`${TEST_CWD}|pi`);

    await launcherSlot(daemon, TEST_CWD, "opencode");
    expect(status(daemon)).toBe("multi_type");
    expect(env.texts().at(-1)).toContain("opencode joined");
    expect(env.texts().at(-1)).toContain("/opencode /pi");

    const repeat = await launcherSlot(daemon, TEST_CWD, "pi");
    expect(repeat.refused).toBe("type_already_open");
    expect(env.created).toHaveLength(2);
  });

  test("multi-instance mode refuses another CLI type in its directory", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, TEST_CWD, "pi");
    env.alive.add(`${TEST_CWD}|pi`);
    await launcherSlot(daemon, TEST_CWD, "pi");
    expect(status(daemon)).toBe("multi_instance");

    const other = await launcherSlot(daemon, TEST_CWD, "codex");

    expect(other.refused).toBe("instance_mode_type_locked");
    expect(env.created).toHaveLength(2);
  });

  test("a window in another directory moves any mode to the multi-directory mode", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, TEST_CWD, "pi");
    env.alive.add(`${TEST_CWD}|pi`);
    await launcherSlot(daemon, TEST_CWD, "pi");

    const other = await launcherSlot(daemon, OTHER_CWD, "codex");

    expect(other.refused).toBeUndefined();
    expect(status(daemon)).toBe("multi_workspace");
    // The upgrade notice is sent fire-and-forget; let it flush before reading.
    await tick();
    expect(env.texts().some((text) => text.includes("other-app/codex joined"))).toBe(true);
  });

  test("closing windows never steps down; a resident daemon left empty starts over", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, TEST_CWD, "pi");
    env.alive.add(`${TEST_CWD}|pi`);
    await launcherSlot(daemon, TEST_CWD, "codex");
    env.alive.add(`${TEST_CWD}|codex`);
    const slots = (daemon as unknown as {
      slotManager: { releaseClosedWindows(nowMs?: number): void };
    }).slotManager;
    slots.releaseClosedWindows();

    env.alive.delete(`${TEST_CWD}|codex`);
    slots.releaseClosedWindows();
    slots.releaseClosedWindows();
    expect(status(daemon)).toBe("multi_type");

    env.alive.delete(`${TEST_CWD}|pi`);
    slots.releaseClosedWindows();
    slots.releaseClosedWindows();
    expect(status(daemon)).toBe("none");
  });
});

describe("remote commands per bridge mode", () => {
  test("/open in a single bridge opens a numbered window and moves to multi-instance mode", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await send(daemon, "/pi");

    await send(daemon, "/open");

    expect(env.opened.map((entry) => entry.title)).toEqual([
      "wechat-pi · daemon-parity",
      "wechat-pi-2 · daemon-parity",
    ]);
    expect(daemon.getStatus().mode).toBe("multi_instance");
    expect(daemon.getStatus().activeInstance).toBe(2);
    expect(env.texts().some((text) => text.includes("A second pi opened"))).toBe(true);
  });

  test("/1 and /2 switch between windows and prefix replies with the number", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await send(daemon, "/pi");
    const first = env.latest();
    await send(daemon, "/open");
    const second = env.latest();

    await send(daemon, "/1 run the tests");
    expect(first.inputs.at(-1)).toContain("run the tests");
    expect(second.inputs).toEqual([]);

    await send(daemon, "/3");
    expect(env.texts().at(-1)).toContain("There is no pi-3. Open: /1, /2");

    env.wechat.sent.length = 0;
    second.emit(event("final_reply", { text: "Done." }));
    await tick(20);
    expect(env.texts()).toEqual(["[pi-2]\nDone."]);
  });

  test("multi-instance mode refuses switching to another CLI type", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/pi");
    await send(daemon, "/open");
    const created = env.created.length;

    await send(daemon, "/codex");

    expect(env.created).toHaveLength(created);
    expect(env.texts().at(-1)).toContain("several pi windows");
    expect(daemon.getStatus().activeAdapter).toBe("pi");
  });

  test("multi-CLI mode refuses /open and does not offer /1", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/pi");
    await send(daemon, "/codex");

    await send(daemon, "/open");
    expect(env.texts().at(-1)).toContain("this directory already has codex");

    await send(daemon, "/1");
    expect(env.texts().at(-1)).toContain("not available in this mode");
  });

  test("/all in multi-instance mode reaches every window", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/pi");
    const first = env.latest();
    await send(daemon, "/open");
    const second = env.latest();

    await send(daemon, "/all check status");

    expect(first.inputs.at(-1)).toContain("check status");
    expect(second.inputs.at(-1)).toContain("check status");
    expect(env.texts().at(-1)).not.toContain("codex");
  });

  test("/status of a single bridge names only the CLI it runs", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/pi");

    await send(daemon, "/status");

    const status = env.texts().at(-1)!;
    expect(status).toContain("Mode: single bridge");
    expect(status).toContain("pi: ");
    expect(status).not.toContain("codex");
  });
});

describe("Codex attach through the daemon", () => {
  const attach = (daemon: BridgeDaemon, threadId?: string) => daemon.handleDaemonRequest({
    command: "ensure_slot",
    adapter: "codex",
    cwd: OTHER_CWD,
    openVisible: false,
    sessionStartMode: "new",
    codexAttach: threadId ? { threadId } : {},
  }) as Promise<Record<string, unknown>>;

  test("attaching adds a windowless codex slot that outlives windows, even in single-bridge mode", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    daemon.setEphemeral(true);

    const claim = await attach(daemon, "thread-7");
    const slots = (daemon as unknown as {
      slotManager: { releaseClosedWindows(nowMs?: number): void };
    }).slotManager;
    slots.releaseClosedWindows(Date.now() + 120_000);

    expect(claim.sharedThreadId).toBe("thread-7");
    expect(env.opened).toEqual([]);
    expect(env.latest().attachThread).toBe("thread-7");
    expect(env.latest().lifecycle).toBe("persistent");
    expect(daemon.getStatus().slots).toHaveLength(1);
    expect(env.exitCodes).toEqual([]);
    expect(daemon.getStatus().mode).toBe("single");
  });

  test("attaching counts as a codex window: refused where multi-CLI mode already has codex", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, OTHER_CWD, "codex");
    await launcherSlot(daemon, OTHER_CWD, "pi");

    const claim = await attach(daemon);

    expect(claim.refused).toBe("type_already_open");
    expect(env.created).toHaveLength(2);
  });

  test("attaching next to a single codex window opens a second codex instance", async () => {
    const env = new Env();
    env.allAlive = false;
    const daemon = env.buildDaemon();
    await launcherSlot(daemon, OTHER_CWD, "codex");

    const claim = await attach(daemon);

    expect(claim.instance).toBe(2);
    expect(env.created).toHaveLength(2);
  });
});

class FakeTelegramTransport {
  readonly texts: { conversationId: string; text: string }[] = [];
  readonly attachments: { conversationId: string; path: string }[] = [];

  async sendText(target: ChannelConversationRef, text: string): Promise<boolean> {
    this.texts.push({ conversationId: target.conversationId, text });
    return true;
  }

  async sendAttachment(target: ChannelConversationRef, attachment: { path: string }): Promise<void> {
    this.attachments.push({ conversationId: target.conversationId, path: attachment.path });
  }

  async beginTyping(): Promise<void> {}
  async endTyping(): Promise<void> {}
  endAllTyping(): void {}
  async stop(): Promise<void> {}
}

describe("Telegram final replies through the daemon", () => {
  test("text and attachments go to the conversation that started the turn", async () => {
    const env = new Env();
    const telegram = new FakeTelegramTransport();
    const daemon = new BridgeDaemon({
      cwd: TEST_CWD,
      authorizedUserId: OPERATOR_ID,
      transport: null,
      channelId: "telegram",
      telegramTransport: telegram as unknown as TelegramTransport,
      deps: env.deps,
    });
    const forward = (adapter: DaemonAdapterKind, conversationId: string, text: string) =>
      daemon.handleDaemonRequest({
        command: "forward_input",
        adapter,
        senderId: OPERATOR_ID,
        conversationId,
        recipientId: conversationId,
        text,
      });
    await forward("codex", "chat-1", "write the report");

    env.runtimeIn(TEST_CWD, "codex").emit(event("final_reply", {
      text: ["Report ready.", "```wechat-attachments", "file /tmp/report.pdf", "```"].join("\n"),
    }));
    // Another conversation talks to another CLI before the reply is delivered.
    await forward("claude", "chat-2", "unrelated question");
    await tick(30);

    expect(telegram.texts.filter((entry) => entry.text.includes("Report ready."))).toEqual([
      { conversationId: "chat-1", text: "[codex]\nReport ready." },
    ]);
    expect(telegram.attachments).toEqual([{ conversationId: "chat-1", path: "/tmp/report.pdf" }]);
  });
});

describe("per-slot session restore", () => {
  test("a slot saves the session it follows and an explicit restore resumes it", async () => {
    const env = new Env();
    env.allAlive = false;
    const first = env.buildDaemon();
    await launcherSlot(first, OTHER_CWD, "claude");
    const claude = env.runtimeIn(OTHER_CWD, "claude");
    claude.state = { ...claude.state, sharedSessionId: "session-42", transcriptPath: "/tmp/t.jsonl" };
    claude.emit(event("status", { status: "idle" }));
    await tick(20);
    expect(env.sessions.read(OTHER_CWD, "claude")).toEqual({
      sharedSessionId: "session-42",
      transcriptPath: "/tmp/t.jsonl",
    });

    const second = env.buildDaemon();
    await second.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "claude",
      cwd: OTHER_CWD,
      openVisible: false,
      sessionStartMode: "restore",
      boundToWindow: true,
    });
    await second.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "pi",
      cwd: OTHER_CWD,
      openVisible: false,
      sessionStartMode: "new",
      boundToWindow: true,
    });

    expect(env.restoredWith).toEqual([undefined, "session-42", undefined]);
  });
});
