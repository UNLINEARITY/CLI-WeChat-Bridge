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
  WechatDaemon,
  type WechatDaemonDeps,
} from "../../src/daemon/wechat-daemon.ts";
import type { PendingWechatMessageStore } from "../../src/channels/wechat/wechat-outbound-queue.ts";
import type {
  InboundWechatMessage,
  WeChatTransport,
} from "../../src/wechat/wechat-transport.ts";

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

  async resolveAllApprovals(): Promise<number> {
    return 0;
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

class Env {
  readonly wechat = new FakeWeChatTransport();
  readonly created: FakeRuntime[] = [];

  readonly deps: WechatDaemonDeps = {
    createRuntime: (params) => {
      const runtime = new FakeRuntime(params.kind, params.cwd, params.command);
      this.created.push(runtime);
      return runtime;
    },
    openVisibleClient: () => ({ command: "fake-visible-client", args: [] }),
    isVisibleClientAlive: () => true,
    daemonLog: () => undefined,
    pendingWechatMessages:
      new FakePendingStore() as unknown as PendingWechatMessageStore,
    visibleClientConnectTimeoutMs: 50,
  };

  buildDaemon(): WechatDaemon {
    return new WechatDaemon({
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

function inbound(text: string, senderId = OPERATOR_ID): InboundWechatMessage {
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

async function send(daemon: WechatDaemon, text: string, senderId?: string): Promise<void> {
  await (daemon as unknown as {
    handleInboundMessage(message: InboundWechatMessage): Promise<void>;
  }).handleInboundMessage(inbound(text, senderId));
}

function event<T extends BridgeEvent["type"]>(
  type: T,
  fields: Omit<Extract<BridgeEvent, { type: T }>, "type" | "timestamp">,
): BridgeEvent {
  return { type, timestamp: new Date().toISOString(), ...fields } as BridgeEvent;
}

describe("daemon behaviors kept after the standalone merge", () => {
  test("prefixes replies from the current adapter with [adapter]", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    await send(daemon, "fix the failing test");
    env.wechat.sent.length = 0;

    env.latest().emit(event("final_reply", { text: "Tests pass now." }));
    await tick(20);

    expect(env.texts()).toEqual(["[claude]\nTests pass now."]);
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
  daemon: WechatDaemon,
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
  test("a launcher in another directory adds a slot there and announces it", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await send(daemon, "/claude");
    env.wechat.sent.length = 0;

    await openWorkspaceSlot(daemon, OTHER_CWD, "codex");

    expect(env.runtimeIn(OTHER_CWD, "codex")).toBeDefined();
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
    expect(daemon.getStatus().activeAdapter).toBe("claude");
    expect(env.texts().at(-1)).toContain("other-app/codex");
    expect(env.texts().at(-1)).toContain("/cd other-app");
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

    await send(daemon, "/cd /etc");

    expect(env.texts().at(-1)).toContain("No directory matches /etc");
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
    expect(env.created).toHaveLength(1);
  });

  test("/cd asks for a number when two directories share a name", async () => {
    const env = new Env();
    const daemon = env.buildDaemon();
    await openWorkspaceSlot(daemon, "/tmp/a/app", "claude");
    await openWorkspaceSlot(daemon, "/tmp/b/app", "claude");

    await send(daemon, "/cd app");

    expect(env.texts().at(-1)).toContain("Several directories are named app");
    expect(daemon.getStatus().cwd).toBe(TEST_CWD);
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

    expect(env.texts()).toEqual(["[other-app/codex]\nBuild finished.", "[claude]\nTests pass."]);
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
    expect(env.texts().at(-1)).toContain("[codex]");

    codex.state = { ...codex.state, status: "idle", activeTurnOrigin: undefined, activeTurnId: undefined };
    codex.emit(event("task_complete", {}));
    await tick(20);

    expect(codex.inputs.at(-1)).toContain("also update the README");
  });
});

describe("daemon behaviors the standalone merge still has to change", () => {
  test.todo("persists per-slot session state so --session-start-mode restore resumes it");
  test.todo("disposes a companion-bound slot on shutdown_requested and exits an ephemeral daemon with no slots left");
});
