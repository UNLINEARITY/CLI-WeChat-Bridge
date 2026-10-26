// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { beforeEach, describe, expect, test } from "bun:test";

import { setLocale } from "../../src/i18n/index.ts";
import type {
  ApprovalDecision,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  PendingApproval,
} from "../../src/bridge/bridge-types.ts";
import type { ChannelConversationRef, ChannelOutputKind } from "../../src/core/channel-types.ts";
import type { PendingMessageStore } from "../../src/core/pending-message-store.ts";
import type { WecomTransport } from "../../src/channels/wecom/wecom-transport.ts";
import type { AgentCallView, AgentSummary } from "../../src/daemon/agent-bus.ts";
import type { DaemonAdapterKind, DaemonRequest } from "../../src/daemon/daemon-link.ts";
import type { SlotSessionRecord, SlotSessionStore } from "../../src/daemon/slot-session-store.ts";
import { BridgeDaemon } from "../../src/daemon/wechat-daemon.ts";

beforeEach(() => setLocale("en"));

const TEST_CWD = "C:\\Users\\test\\agent-bus";
const OPERATOR_ID = "operator-001";

async function tick(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakeWecomTransport {
  readonly sent: { target: ChannelConversationRef; text: string; kind: ChannelOutputKind }[] = [];

  async sendText(target: ChannelConversationRef, text: string, kind: ChannelOutputKind): Promise<boolean> {
    this.sent.push({ target: { ...target }, text, kind });
    return true;
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

class MemorySessionStore implements SlotSessionStore {
  readonly records = new Map<string, SlotSessionRecord>();

  read(cwd: string, adapter: DaemonAdapterKind): SlotSessionRecord | null {
    return this.records.get(`${cwd}|${adapter}`) ?? null;
  }

  write(cwd: string, adapter: DaemonAdapterKind, record: SlotSessionRecord): void {
    this.records.set(`${cwd}|${adapter}`, record);
  }
}

class FakeRuntime implements BridgeAdapter {
  state: BridgeAdapterState;
  readonly inputs: string[] = [];
  readonly approvals: ApprovalDecision[] = [];
  interrupts = 0;
  private sink: ((event: BridgeEvent) => void) | null = null;

  constructor(adapter: DaemonAdapterKind, cwd: string, command: string) {
    this.state = {
      kind: adapter,
      status: "idle",
      cwd,
      command,
      // A visible Codex window counts as ready once it follows a thread.
      ...(adapter === "codex" ? { sharedThreadId: "thread-visible", lastThreadSwitchSource: "local" as const } : {}),
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
    this.interrupts += 1;
    return true;
  }

  async reset(): Promise<void> {}

  async resolveApproval(action: ApprovalDecision): Promise<boolean> {
    this.approvals.push(action);
    this.state = { ...this.state, status: "busy", pendingApproval: null };
    return true;
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
  readonly wecom = new FakeWecomTransport();
  /** Runtimes by slot name: `codex`, `codex-101` for a worker. */
  readonly runtimes = new Map<string, FakeRuntime>();
  readonly logs: string[] = [];
  readonly daemon: BridgeDaemon;

  constructor() {
    this.daemon = new BridgeDaemon({
      cwd: TEST_CWD,
      authorizedUserId: OPERATOR_ID,
      transport: null,
      channelId: "wecom",
      wecomTransport: this.wecom as unknown as WecomTransport,
      deps: {
        createRuntime: (params) => {
          const runtime = new FakeRuntime(params.kind, params.cwd, params.command);
          this.runtimes.set(params.slotInstance ? `${params.kind}-${params.slotInstance}` : params.kind, runtime);
          return runtime;
        },
        openVisibleClient: () => ({ command: "fake-visible-client", args: [] }),
        isVisibleClientAlive: () => true,
        daemonLog: (message) => {
          this.logs.push(message);
        },
        pendingMessages: new FakePendingStore() as unknown as PendingMessageStore,
        visibleClientConnectTimeoutMs: 50,
        fatalNoticeGraceMs: 0,
        slotSessions: new MemorySessionStore(),
      },
    });
  }

  runtime(adapter: DaemonAdapterKind | `${DaemonAdapterKind}-${number}`): FakeRuntime {
    const runtime = this.runtimes.get(adapter);
    if (!runtime) throw new Error(`runtime ${adapter} was never created`);
    return runtime;
  }

  request<T>(request: DaemonRequest): Promise<T> {
    return this.daemon.handleDaemonRequest(request) as Promise<T>;
  }

  async open(...adapters: DaemonAdapterKind[]): Promise<void> {
    for (const adapter of adapters) {
      await this.request({ command: "ensure_slot", adapter, cwd: TEST_CWD, openVisible: false });
    }
  }

  call(caller: DaemonAdapterKind, target: DaemonAdapterKind, text: string): Promise<AgentCallView> {
    return this.request({
      command: "agent_call",
      caller: { cwd: TEST_CWD, adapter: caller },
      target: { cwd: TEST_CWD, adapter: target },
      text,
    });
  }

  get(callId: string, consume = false): Promise<AgentCallView> {
    return this.request({ command: "agent_get", callId, consume });
  }

  /** The adapter answers and ends its current turn. */
  async finishTurn(adapter: DaemonAdapterKind | `${DaemonAdapterKind}-${number}`, reply: string): Promise<void> {
    const runtime = this.runtime(adapter);
    const timestamp = new Date().toISOString();
    runtime.emit({ type: "final_reply", text: reply, timestamp });
    runtime.emit({ type: "task_complete", timestamp });
    await tick(6);
  }

  notices(): string[] {
    return this.wecom.sent.filter((message) => message.kind === "notice").map((message) => message.text);
  }
}

const deployApproval: PendingApproval = {
  source: "cli",
  summary: "Run the deploy script?",
  commandPreview: "npm run deploy",
  requestId: "approval-1",
  createdAt: "2026-06-01T00:00:00.000Z",
};

async function emitApproval(runtime: FakeRuntime): Promise<void> {
  runtime.state = { ...runtime.state, status: "awaiting_approval", pendingApproval: deployApproval };
  runtime.emit({ type: "approval_required", request: deployApproval, timestamp: new Date().toISOString() });
  await tick(6);
}

describe("agent bus calls", () => {
  test("runs a call as a target turn, mirrors it, and delivers the result to the caller", async () => {
    const env = new Env();
    await env.open("claude", "codex");

    const started = await env.call("claude", "codex", "write the parser tests");
    expect(started.status).toBe("running");
    expect(started.caller).toBe("claude");
    expect(env.runtime("codex").inputs.at(-1)).toBe(`[Task ${started.callId} from claude]\nwrite the parser tests`);
    expect(env.notices().some((text) => text.includes("Task from claude:\nwrite the parser tests"))).toBe(true);

    await env.finishTurn("codex", "added 4 tests");

    const settled = await env.get(started.callId);
    expect(settled.status).toBe("completed");
    expect(settled.reply).toBe("added 4 tests");
    expect(env.runtime("claude").inputs.at(-1)).toBe(`[codex finished task ${started.callId}]\nadded 4 tests`);
    // The target's reply still reaches the operator like any other turn.
    expect(env.wecom.sent.some((message) => message.kind === "final_reply" && message.text.includes("added 4 tests"))).toBe(true);
  });

  test("queues a call while the target is busy and starts it when the turn ends", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    const first = await env.call("claude", "codex", "first");
    const second = await env.call("claude", "codex", "second");

    expect(second.status).toBe("queued");
    expect(second.queuePosition).toBe(1);
    expect(env.runtime("codex").inputs).toHaveLength(1);

    await env.finishTurn("codex", "first done");

    expect((await env.get(first.callId)).status).toBe("completed");
    expect((await env.get(second.callId)).status).toBe("running");
    expect(env.runtime("codex").inputs.at(-1)).toContain("second");
  });

  test("keeps a result the caller already read out of its next turns", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    const call = await env.call("claude", "codex", "check the build");
    // Claude is in a turn of its own when codex finishes.
    await env.request({ command: "forward_input", adapter: "claude", text: "other work", senderId: OPERATOR_ID });
    const claudeInputs = env.runtime("claude").inputs.length;

    await env.finishTurn("codex", "build is green");
    expect((await env.get(call.callId, true)).reply).toBe("build is green");
    await env.finishTurn("claude", "done with other work");

    expect(env.runtime("claude").inputs).toHaveLength(claudeInputs);
  });

  test("refuses a call that would loop back to a waiting caller", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    await env.call("claude", "codex", "review this");

    await expect(env.call("codex", "claude", "ask back")).rejects.toThrow("loop back");
  });

  test("lets only the direct caller decide the callee's approval", async () => {
    const env = new Env();
    await env.open("claude", "codex", "opencode");
    const call = await env.call("claude", "codex", "deploy");
    await emitApproval(env.runtime("codex"));

    const waiting = await env.get(call.callId);
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.pendingApproval?.commandPreview).toBe("npm run deploy");
    expect(env.runtime("claude").inputs.at(-1)).toContain(`[codex needs approval for task ${call.callId}]`);

    await expect(env.request({
      command: "agent_approve",
      callId: call.callId,
      caller: { cwd: TEST_CWD, adapter: "opencode" },
      decision: "confirm",
    })).rejects.toThrow("Only the agent that made this call");

    const result = await env.request<{ resolved: boolean }>({
      command: "agent_approve",
      callId: call.callId,
      caller: { cwd: TEST_CWD, adapter: "claude" },
      decision: "confirm",
    });
    expect(result.resolved).toBe(true);
    expect(env.runtime("codex").approvals).toEqual(["confirm"]);
    await tick();
    expect(env.notices().some((text) => text.includes("claude approved: npm run deploy"))).toBe(true);
  });

  test("fails pending calls when the target closes and tells the caller", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    const call = await env.call("claude", "codex", "long job");

    env.runtime("codex").emit({ type: "fatal_error", message: "codex exited", timestamp: new Date().toISOString() });
    await tick(6);

    const failed = await env.get(call.callId);
    expect(failed.status).toBe("failed");
    expect(env.runtime("claude").inputs.at(-1)).toContain(`[codex failed task ${call.callId}]`);
  });

  test("interrupts a running call and reports it as stopped", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    const call = await env.call("claude", "codex", "slow job");

    await env.request({ command: "agent_interrupt", callId: call.callId });
    expect(env.runtime("codex").interrupts).toBe(1);
    env.runtime("codex").emit({ type: "task_complete", timestamp: new Date().toISOString() });
    await tick(6);

    expect((await env.get(call.callId)).status).toBe("interrupted");
    expect(env.runtime("claude").inputs.at(-1)).toBe(`[codex task ${call.callId} was stopped]`);
  });

  test("wakes a waiter when the call settles and lists the agents", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    const call = await env.call("claude", "codex", "quick");
    const waiting = env.request<AgentCallView>({ command: "agent_wait", callId: call.callId, waitMs: 5_000, consume: true });

    const agents = await env.request<AgentSummary[]>({ command: "agent_list" });
    expect(agents.find((agent) => agent.adapter === "codex")?.activeCallId).toBe(call.callId);

    await env.finishTurn("codex", "quick done");
    const settled = await waiting;
    expect(settled.status).toBe("completed");
    expect(settled.reply).toBe("quick done");
  });
});

describe("agent bus workers", () => {
  const claude = { cwd: TEST_CWD, adapter: "claude" as const };

  test("opens a Codex worker beside the operator's codex without changing the bridge mode", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    const modeBefore = env.daemon.getStatus().mode;

    const worker = await env.request<AgentSummary>({ command: "agent_open", caller: claude, adapter: "codex" });
    expect(worker.name).toBe("codex-w1");
    expect(worker.worker).toEqual({ owner: "claude" });

    const status = env.daemon.getStatus();
    expect(status.mode).toBe(modeBefore);
    expect(status.activeAdapter).toBe("codex");
    expect(status.slots.map((slot) => slot.instance)).not.toContain(101);

    const call = await env.request<AgentCallView>({
      command: "agent_call",
      caller: claude,
      target: { cwd: TEST_CWD, adapter: "codex", name: "codex-w1" },
      text: "split the module",
    });
    expect(call.target).toBe("codex-w1");
    expect(env.runtime("codex-101").inputs.at(-1)).toContain("split the module");
    expect(env.runtime("codex").inputs).toHaveLength(0);
    expect(env.notices().some((text) => text.startsWith("[claude→codex-w1]"))).toBe(true);

    await env.finishTurn("codex-101", "split into 3 files");
    expect((await env.get(call.callId)).status).toBe("completed");
    expect(env.runtime("claude").inputs.at(-1)).toContain("[codex-w1 finished task");
  });

  test("lets only the owner close a worker and closes workers with their owner", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    await env.request({ command: "agent_open", caller: claude, adapter: "codex" });
    const workerRef = { cwd: TEST_CWD, adapter: "codex" as const, name: "codex-w1" };

    await expect(env.request({ command: "agent_close", caller: { cwd: TEST_CWD, adapter: "codex" }, target: workerRef }))
      .rejects.toThrow("Only the agent that opened codex-w1");
    await env.request({ command: "agent_close", caller: claude, target: workerRef });
    let agents = await env.request<AgentSummary[]>({ command: "agent_list" });
    expect(agents.some((agent) => agent.worker)).toBe(false);

    await env.request({ command: "agent_open", caller: claude, adapter: "codex" });
    env.runtime("claude").emit({ type: "fatal_error", message: "claude exited", timestamp: new Date().toISOString() });
    await tick(6);
    agents = await env.request<AgentSummary[]>({ command: "agent_list" });
    expect(agents.map((agent) => agent.name)).toEqual(["codex"]);
  });

  test("caps the workers one agent keeps open", async () => {
    const env = new Env();
    await env.open("claude", "codex");
    for (let index = 0; index < 4; index += 1) {
      await env.request({ command: "agent_open", caller: claude, adapter: "codex" });
    }
    await expect(env.request({ command: "agent_open", caller: claude, adapter: "codex" })).rejects.toThrow("at most 4 workers");
    const names = (await env.request<AgentSummary[]>({ command: "agent_list" })).map((agent) => agent.name);
    expect(names).toEqual(["claude", "codex", "codex-w1", "codex-w2", "codex-w3", "codex-w4"]);
  });
});
