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
  private sink: ((event: BridgeEvent) => void) | null = null;

  constructor(adapter: DaemonAdapterKind, cwd: string, command: string) {
    this.state = { kind: adapter, status: "idle", cwd, command };
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

  async resolveApproval(): Promise<boolean> {
    return true;
  }

  async resolveAllApprovals(): Promise<number> {
    return 0;
  }

  async submitUserInput(): Promise<boolean> {
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

describe("daemon behaviors the standalone merge still has to change", () => {
  test.todo("queues WeChat input during a local Codex turn and drains it afterwards");
  test.todo("persists per-slot session state so --session-start-mode restore resumes it");
  test.todo("disposes a companion-bound slot on shutdown_requested and exits an ephemeral daemon with no slots left");
  test.todo("/confirm <n> and /deny <n> resolve a pending request outside the current directory");
  test.todo("prefixes output from a non-current directory with [directory/adapter]");
});
