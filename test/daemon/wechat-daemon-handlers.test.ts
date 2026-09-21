import { describe, expect, test } from "bun:test";

import type {
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeWorkerStatus,
  PendingApproval,
  PendingUserInputRequest,
} from "../../src/bridge/bridge-types.ts";
import type {
  ChannelConversationRef,
  ChannelOutputKind,
} from "../../src/core/channel-types.ts";
import type {
  DaemonAdapterKind,
  DaemonForwardInputResult,
  DaemonRequest,
  DaemonSendTextResult,
} from "../../src/daemon/daemon-link.ts";
import {
  WechatDaemon,
  type WechatDaemonDeps,
} from "../../src/daemon/wechat-daemon.ts";
import type { WecomTransport } from "../../src/channels/wecom/wecom-transport.ts";
import type { WeChatTransport } from "../../src/wechat/wechat-transport.ts";
import type { PendingWechatMessageStore } from "../../src/channels/wechat/wechat-outbound-queue.ts";
import type { WechatSendContext } from "../../src/channels/wechat/wechat-forwarding.ts";

const TEST_CWD = "C:\\Users\\test\\daemon-handlers";
const OPERATOR_ID = "operator-001";

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type SentWecomMessage = {
  target: ChannelConversationRef;
  text: string;
  kind: ChannelOutputKind;
};

class FakeWecomTransport {
  readonly sent: SentWecomMessage[] = [];

  async sendText(
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ): Promise<boolean> {
    this.sent.push({ target: { ...target }, text, kind });
    return true;
  }
}

class FakeWeChatTransport {
  readonly sent: { recipientId: string; text: string }[] = [];

  async sendText(recipientId: string, text: string): Promise<void> {
    this.sent.push({ recipientId, text });
  }
}

/** Records nothing: the daemon only enqueues on send failures. */
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

/**
 * A BridgeAdapter that records every interaction. Input submission can be
 * held (to exercise concurrency) or failed (to exercise rollback), and the
 * stored event sink lets tests push adapter events into the daemon exactly
 * like a real runtime would.
 */
class FakeBridgeRuntime implements BridgeAdapter {
  readonly adapter: DaemonAdapterKind;
  state: BridgeAdapterState;
  readonly inputs: string[] = [];
  readonly approvals: Array<"confirm" | "deny"> = [];
  readonly userInput: Record<string, string[]>[] = [];
  private holdInput = false;
  private sink: ((event: BridgeEvent) => void) | null = null;
  private resolveInput: (() => void) | null = null;
  private inputError: Error | null = null;

  constructor(adapter: DaemonAdapterKind, cwd: string, command: string) {
    this.adapter = adapter;
    this.state = {
      kind: adapter,
      status: "idle",
      cwd,
      command,
      ...(adapter === "codex"
        ? {
            sharedThreadId: "thread-visible",
            lastThreadSwitchSource: "local" as const,
          }
        : {}),
    };
  }

  setStatus(status: BridgeWorkerStatus): void {
    this.state = { ...this.state, status };
  }

  setLocalTurnBusy(): void {
    this.state = {
      ...this.state,
      status: "busy",
      activeTurnOrigin: "local",
      activeTurnId: "local-turn",
    };
  }

  clearTurn(): void {
    this.state = {
      ...this.state,
      status: "idle",
      activeTurnOrigin: undefined,
      activeTurnId: undefined,
    };
  }

  /** Make the next sendInput reject with this error. */
  failNextInput(error: Error): void {
    this.inputError = error;
  }

  /** Make the next sendInput block until releaseInput() is called. */
  holdNextInput(): void {
    this.holdInput = true;
  }

  releaseInput(): void {
    this.holdInput = false;
    this.resolveInput?.();
    this.resolveInput = null;
  }

  /** Push an adapter event into the daemon. */
  emit(event: BridgeEvent): void {
    this.sink?.(event);
  }

  setEventSink(sink: (event: BridgeEvent) => void): void {
    this.sink = sink;
  }

  async start(): Promise<void> {
    // No PTY to spawn.
  }

  async sendInput(text: string): Promise<void> {
    this.inputs.push(text);
    if (this.inputError) {
      const error = this.inputError;
      this.inputError = null;
      throw error;
    }
    if (this.holdInput) {
      await new Promise<void>((resolve) => {
        this.resolveInput = resolve;
      });
    }
  }

  async listResumeSessions(): Promise<[]> {
    return [];
  }

  async resumeSession(): Promise<void> {
    // Not exercised by these tests.
  }

  async interrupt(): Promise<boolean> {
    return true;
  }

  async reset(): Promise<void> {
    this.setStatus("idle");
  }

  async resolveApproval(): Promise<boolean> {
    return true;
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    this.approvals.push(action);
    return 1;
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    this.userInput.push(answers);
    return true;
  }

  async dispose(): Promise<void> {
    // No child process to reap.
  }

  getState(): BridgeAdapterState {
    return this.state;
  }
}

/**
 * Injects fakes for every daemon side effect (PTY, visible terminal, log
 * files, pending-message store) so the real handler layer can be driven
 * directly. Defaults match a healthy daemon: the visible client is alive and
 * no terminal is ever spawned.
 */
class FakeDaemonEnvironment {
  readonly wecom = new FakeWecomTransport();
  readonly wechat = new FakeWeChatTransport();
  readonly runtimes = new Map<DaemonAdapterKind, FakeBridgeRuntime>();
  readonly logs: string[] = [];
  readonly openedVisible: DaemonAdapterKind[] = [];
  visibleAlive = true;
  /** Hold the very first input submitted to the created runtime. */
  holdFirstInput = false;

  readonly deps: WechatDaemonDeps = {
    createRuntime: (params) => {
      const runtime = new FakeBridgeRuntime(
        params.kind,
        params.cwd,
        params.command,
      );
      if (this.holdFirstInput) {
        this.holdFirstInput = false;
        runtime.holdNextInput();
      }
      this.runtimes.set(params.kind, runtime);
      return runtime;
    },
    openVisibleClient: (params) => {
      this.openedVisible.push(params.adapter);
      return { command: "fake-visible-client", args: [] };
    },
    isVisibleClientAlive: () => this.visibleAlive,
    daemonLog: (message) => {
      this.logs.push(message);
    },
    pendingWechatMessages:
      new FakePendingStore() as unknown as PendingWechatMessageStore,
    visibleClientConnectTimeoutMs: 50,
  };

  buildDaemon(channelId: "wecom" | "wechat" = "wecom"): WechatDaemon {
    return new WechatDaemon({
      cwd: TEST_CWD,
      authorizedUserId: OPERATOR_ID,
      transport: this.wechat as unknown as WeChatTransport,
      channelId,
      wecomTransport:
        channelId === "wecom"
          ? (this.wecom as unknown as WecomTransport)
          : null,
      deps: this.deps,
    });
  }

  runtime(adapter: DaemonAdapterKind): FakeBridgeRuntime {
    const runtime = this.runtimes.get(adapter);
    if (!runtime) {
      throw new Error(`runtime ${adapter} was never created`);
    }
    return runtime;
  }

  /** Wait for a slot's runtime to be created by an in-flight request. */
  async awaitRuntime(
    daemon: WechatDaemon,
    adapter: DaemonAdapterKind,
  ): Promise<FakeBridgeRuntime> {
    while (this.runtimes.size === 0 || !this.runtimes.has(adapter)) {
      await tick();
      if (this.runtimes.has(adapter)) {
        break;
      }
    }
    return this.runtime(adapter);
  }
}

function forwardInputRequest(params: {
  adapter?: DaemonAdapterKind;
  text: string;
  conversationId: string;
}): Extract<DaemonRequest, { command: "forward_input" }> {
  return {
    command: "forward_input",
    ...(params.adapter ? { adapter: params.adapter } : {}),
    senderId: OPERATOR_ID,
    conversationId: params.conversationId,
    recipientId: OPERATOR_ID,
    text: params.text,
  };
}

async function forwardInput(
  daemon: WechatDaemon,
  params: { adapter?: DaemonAdapterKind; text: string; conversationId: string },
): Promise<DaemonForwardInputResult> {
  return (await daemon.handleDaemonRequest(
    forwardInputRequest(params),
  )) as DaemonForwardInputResult;
}

async function sendText(
  daemon: WechatDaemon,
  request: Extract<DaemonRequest, { command: "send_text" }>,
): Promise<DaemonSendTextResult> {
  return (await daemon.handleDaemonRequest(request)) as DaemonSendTextResult;
}

async function expectRejection(
  promise: Promise<unknown>,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  return new Error("expected the request to fail");
}

const pendingApproval: PendingApproval = {
  source: "cli",
  summary: "Run the deploy script?",
  commandPreview: "npm run deploy",
  code: "APPROVE-1",
  createdAt: "2026-06-01T00:00:00.000Z",
};

const pendingUserInput: PendingUserInputRequest = {
  summary: "Choose an environment",
  questions: [
    {
      id: "env",
      header: "Environment",
      question: "Which environment?",
      isOther: false,
      isSecret: false,
    },
  ],
  createdAt: "2026-06-01T00:00:00.000Z",
};

function notice(text: string): BridgeEvent {
  return {
    type: "notice",
    text,
    level: "info",
    timestamp: new Date().toISOString(),
  };
}

function stdout(text: string): BridgeEvent {
  return {
    type: "stdout",
    text,
    timestamp: new Date().toISOString(),
  };
}


describe("wechat-daemon handlers: /all broadcast", () => {
  type InboundMessageParams = {
    senderId?: string;
    text: string;
    sessionId?: string;
  };

  function inboundMessage(params: InboundMessageParams): InboundWechatMessage {
    return {
      senderId: params.senderId ?? OPERATOR_ID,
      sender: params.senderId ?? OPERATOR_ID,
      sessionId: params.sessionId ?? OPERATOR_ID,
      text: params.text,
      attachments: [],
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    };
  }

  async function sendInbound(
    daemon: WechatDaemon,
    params: InboundMessageParams,
  ): Promise<void> {
    await (daemon as unknown as {
      handleInboundMessage(message: InboundWechatMessage): Promise<void>;
    }).handleInboundMessage(inboundMessage(params));
  }

  function lastNotice(env: FakeDaemonEnvironment): string {
    return env.wecom.sent[env.wecom.sent.length - 1]!.text;
  }

  test("broadcasts to every started slot and lists skipped adapters", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, { adapter: "codex", text: "warm codex", conversationId: "conv-1" });
    await forwardInput(daemon, { adapter: "pi", text: "warm pi", conversationId: "conv-2" });
    for (const adapter of ["codex", "pi"] as const) {
      env.runtime(adapter).emit({
        type: "final_reply",
        text: "warm done",
        timestamp: new Date().toISOString(),
      });
      env.runtime(adapter).emit({
        type: "task_complete",
        timestamp: new Date().toISOString(),
      });
    }
    await tick(20);
    env.wecom.sent.length = 0;

    await sendInbound(daemon, { text: "/all compare notes on task X" });

    expect(env.runtime("codex").inputs.at(-1)).toContain("compare notes on task X");
    expect(env.runtime("pi").inputs.at(-1)).toContain("compare notes on task X");
    const notice = lastNotice(env);
    expect(notice).toContain("Broadcast dispatched to 2 workers: codex, pi.");
    expect(notice).toContain("Not started (skipped): claude, opencode.");
  });

  test("cancels the whole broadcast when any started slot is busy", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, { adapter: "codex", text: "warm codex", conversationId: "conv-1" });
    await forwardInput(daemon, { adapter: "pi", text: "warm pi", conversationId: "conv-2" });
    // Turn 1 in flight on pi: turns.hasActiveTask is true until completion.
    env.wecom.sent.length = 0;

    await sendInbound(daemon, { text: "/all shared prompt" });

    const notice = lastNotice(env);
    expect(notice).toContain("/all canceled");
    expect(notice).toContain("pi");
    expect(env.runtime("codex").inputs).toHaveLength(1);
    expect(env.runtime("pi").inputs).toHaveLength(1);
  });

  test("cancels when a slot has a pending approval", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, { adapter: "codex", text: "warm", conversationId: "conv-1" });
    env.runtime("codex").emit({
      type: "approval_required",
      request: pendingApproval,
      timestamp: new Date().toISOString(),
    });
    await tick();
    env.wecom.sent.length = 0;

    await sendInbound(daemon, { text: "/all anything" });

    expect(lastNotice(env)).toContain("/all canceled");
    expect(env.runtime("codex").inputs).toHaveLength(1);
  });

  test("answers with the standard guidance when no adapter slot is running", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    await sendInbound(daemon, { text: "/all hello" });

    expect(lastNotice(env)).toContain("No active terminal is selected.");
  });

  test("keeps the active adapter unchanged after a broadcast", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, { adapter: "codex", text: "warm", conversationId: "conv-1" });
    await forwardInput(daemon, { adapter: "pi", text: "warm", conversationId: "conv-2" });
    for (const adapter of ["codex", "pi"] as const) {
      env.runtime(adapter).emit({
        type: "task_complete",
        timestamp: new Date().toISOString(),
      });
    }
    await tick(20);
    const activeBefore = daemon.getStatus().activeAdapter;

    await sendInbound(daemon, { text: "/all ping everyone" });

    expect(daemon.getStatus().activeAdapter).toBe(activeBefore);
  });
});

describe("wechat-daemon handlers: send_text", () => {
  test("delivers text to the requested WeCom conversation", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    const result = await sendText(daemon, {
      command: "send_text",
      recipientId: OPERATOR_ID,
      conversationId: "conv-notice",
      text: "hello from the orchestrator",
      context: "notice",
    });

    expect(result).toEqual({
      sent: true,
      recipientId: OPERATOR_ID,
      conversationId: "conv-notice",
    });
    expect(env.wecom.sent).toHaveLength(1);
    expect(env.wecom.sent[0]!.target.conversationId).toBe("conv-notice");
    expect(env.wecom.sent[0]!.target.recipientId).toBe(OPERATOR_ID);
    expect(env.wecom.sent[0]!.text).toContain("hello from the orchestrator");
  });

  test("defaults context to message and still sends", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    await sendText(daemon, {
      command: "send_text",
      recipientId: OPERATOR_ID,
      conversationId: "conv-default",
      text: "no context given",
    });

    expect(env.wecom.sent).toHaveLength(1);
    expect(env.wecom.sent[0]!.target.conversationId).toBe("conv-default");
  });

  test("rejects unknown context values instead of coercing them", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    const error = await expectRejection(
      daemon.handleDaemonRequest({
        command: "send_text",
        recipientId: OPERATOR_ID,
        conversationId: "conv-1",
        text: "hello",
        context: "bogus" as WechatSendContext,
      }),
    );

    expect(error.message).toContain("Invalid send_text context");
    expect(error.message).toContain('"bogus"');
    expect(error.message).toContain("final_reply");
    expect(error.message).toContain("thinking");
    expect(env.wecom.sent).toHaveLength(0);
  });

  test("the WeChat channel sends straight to the recipient", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wechat");

    const result = await sendText(daemon, {
      command: "send_text",
      recipientId: "wechat-owner",
      text: "hi",
    });

    expect(result).toEqual({ sent: true, recipientId: "wechat-owner" });
    expect(env.wechat.sent).toEqual([
      { recipientId: "wechat-owner", text: "hi" },
    ]);
    expect(env.wecom.sent).toHaveLength(0);
  });
});

describe("wechat-daemon handlers: forward_input dispatch", () => {
  test("submits the prompt to the requested adapter", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    const result = await forwardInput(daemon, {
      adapter: "codex",
      text: "fix the failing test",
      conversationId: "conv-1",
    });

    expect(result).toEqual({
      forwarded: true,
      adapter: "codex",
      conversationId: "conv-1",
    });
    expect(env.runtime("codex").inputs).toEqual(["fix the failing test"]);
    expect(daemon.getSlotState("codex")).toMatchObject({
      active: true,
      hasActiveTask: true,
      activeConversationId: "conv-1",
      lastConversationId: "conv-1",
    });
  });

  test("requires non-empty text", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    const error = await expectRejection(
      daemon.handleDaemonRequest({
        command: "forward_input",
        adapter: "codex",
        text: "   ",
      }),
    );

    expect(error.message).toBe("forward_input requires non-empty text.");
  });

  test("refuses to cross workspace boundaries", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    const error = await expectRejection(
      daemon.handleDaemonRequest({
        command: "forward_input",
        adapter: "codex",
        cwd: "D:\\other-project",
        text: "hello",
      }),
    );

    expect(error.message).toContain("is bound to");
    expect(env.runtimes.size).toBe(0);
  });

  test("fails closed when the visible CLI never connects", async () => {
    const env = new FakeDaemonEnvironment();
    env.visibleAlive = false;
    const daemon = env.buildDaemon("wecom");

    const result = await forwardInput(daemon, {
      adapter: "claude",
      text: "hello",
      conversationId: "conv-1",
    });

    expect(result).toMatchObject({
      forwarded: false,
      reason: "not_activated",
      adapter: "claude",
      conversationId: "conv-1",
    });
    expect(result.message).toContain("not connected");
    expect(env.openedVisible).toContain("claude");
    expect(env.runtime("claude").inputs).toHaveLength(0);
    expect(daemon.getSlotState("claude")?.activeConversationId).toBeUndefined();
    expect(daemon.getSlotState("claude")?.active).toBe(false);
    expect(env.wecom.sent).toHaveLength(0);
  });
});

describe("wechat-daemon handlers: state machine", () => {
  test("reminds about a pending approval instead of dispatching", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, {
      adapter: "codex",
      text: "first prompt",
      conversationId: "conv-1",
    });
    env.runtime("codex").emit({
      type: "approval_required",
      request: pendingApproval,
      timestamp: new Date().toISOString(),
    });
    await tick();

    const result = await forwardInput(daemon, {
      adapter: "codex",
      text: "second prompt",
      conversationId: "conv-2",
    });

    expect(result.forwarded).toBe(false);
    expect(result.reason).toBe("pending_approval");
    expect(result.message).toContain(pendingApproval.commandPreview);
    expect(env.runtime("codex").inputs).toHaveLength(1);
    // sent[0] is the approval event itself, routed to the slot's own
    // conversation; the reminder for the second request goes to its own.
    expect(env.wecom.sent).toHaveLength(2);
    expect(env.wecom.sent[0]!.target.conversationId).toBe("conv-1");
    expect(env.wecom.sent[0]!.kind).toBe("approval_required");
    expect(env.wecom.sent[1]!.target.conversationId).toBe("conv-2");
    expect(env.wecom.sent[1]!.kind).toBe("approval_required");
    // A declined forward must not claim the slot's conversation refs.
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-1");
  });

  test("reminds about pending structured user input", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, {
      adapter: "codex",
      text: "first prompt",
      conversationId: "conv-1",
    });
    env.runtime("codex").emit({
      type: "user_input_required",
      request: pendingUserInput,
      timestamp: new Date().toISOString(),
    });
    await tick();

    const result = await forwardInput(daemon, {
      adapter: "codex",
      text: "second prompt",
      conversationId: "conv-2",
    });

    expect(result.forwarded).toBe(false);
    expect(result.reason).toBe("pending_user_input");
    expect(result.message).toContain("waiting for user input for Environment");
    expect(env.runtime("codex").inputs).toHaveLength(1);
    // sent[0] is the user-input event itself (slot's conversation); the
    // reminder reaches the requesting conversation.
    expect(env.wecom.sent).toHaveLength(2);
    expect(env.wecom.sent[0]!.target.conversationId).toBe("conv-1");
    expect(env.wecom.sent[0]!.kind).toBe("user_input_required");
    expect(env.wecom.sent[1]!.target.conversationId).toBe("conv-2");
    expect(env.wecom.sent[1]!.kind).toBe("user_input_required");
  });

  test("reminds that the adapter is busy", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, {
      adapter: "codex",
      text: "first prompt",
      conversationId: "conv-1",
    });
    env.runtime("codex").setStatus("busy");

    const result = await forwardInput(daemon, {
      adapter: "codex",
      text: "second prompt",
      conversationId: "conv-2",
    });

    expect(result.forwarded).toBe(false);
    expect(result.reason).toBe("busy");
    expect(result.message).toContain("is still working");
    expect(env.runtime("codex").inputs).toHaveLength(1);
    expect(env.wecom.sent).toHaveLength(1);
    expect(env.wecom.sent[0]!.target.conversationId).toBe("conv-2");
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-1");
  });

  test("queues input during a local Codex turn and drains it after completion", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "codex",
      cwd: TEST_CWD,
      openVisible: false,
    });
    const runtime = env.runtime("codex");
    runtime.setLocalTurnBusy();

    const queued = await forwardInput(daemon, {
      adapter: "codex",
      text: "queue behind local work",
      conversationId: "conv-deferred",
    });

    expect(queued).toMatchObject({
      forwarded: false,
      queued: true,
      queuePosition: 1,
      reason: "deferred",
      adapter: "codex",
      conversationId: "conv-deferred",
    });
    expect(runtime.inputs).toHaveLength(0);
    expect(daemon.getStatus().activeAdapter).toBe("codex");
    expect(env.wecom.sent.at(-1)!.target.conversationId).toBe("conv-deferred");
    expect(env.wecom.sent.at(-1)!.text).toContain("Queued for delivery");

    runtime.clearTurn();
    runtime.emit({
      type: "task_complete",
      timestamp: new Date().toISOString(),
    });
    await tick(20);

    expect(runtime.inputs).toEqual(["queue behind local work"]);
    expect(daemon.getSlotState("codex")).toMatchObject({
      activeConversationId: "conv-deferred",
      hasActiveTask: true,
    });
  });

  test("rejects deferred input when the per-slot queue reaches its limit", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "codex",
      cwd: TEST_CWD,
      openVisible: false,
    });
    env.runtime("codex").setLocalTurnBusy();

    for (let index = 0; index < 32; index += 1) {
      const result = await forwardInput(daemon, {
        adapter: "codex",
        text: `queued prompt ${index}`,
        conversationId: `conv-${index}`,
      });
      expect(result.queued).toBe(true);
    }

    const overflow = await forwardInput(daemon, {
      adapter: "codex",
      text: "overflow prompt",
      conversationId: "conv-overflow",
    });
    expect(overflow).toMatchObject({
      forwarded: false,
      reason: "busy",
      adapter: "codex",
      conversationId: "conv-overflow",
    });
    expect(overflow.queued).not.toBe(true);
    expect(overflow.message).toContain("queue is full");
  });

  test("restores the previous active adapter after a rejected non-active request", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, {
      adapter: "codex",
      text: "keep codex active",
      conversationId: "conv-codex",
    });
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "claude",
      cwd: TEST_CWD,
      openVisible: false,
    });
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "codex",
      cwd: TEST_CWD,
      openVisible: false,
    });
    env.runtime("claude").setStatus("busy");

    const result = await forwardInput(daemon, {
      adapter: "claude",
      text: "do not replace active adapter",
      conversationId: "conv-claude",
    });

    expect(result.reason).toBe("busy");
    expect(daemon.getStatus().activeAdapter).toBe("codex");
    expect(daemon.getSlotState("claude")?.activeConversationId).toBeUndefined();
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-codex");
  });

  test("serializes concurrent input to one adapter without conversation clobbering", async () => {
    const env = new FakeDaemonEnvironment();
    env.holdFirstInput = true;
    const daemon = env.buildDaemon("wecom");

    const first = forwardInput(daemon, {
      adapter: "codex",
      text: "first prompt",
      conversationId: "conv-1",
    });
    const runtime = await env.awaitRuntime(daemon, "codex");
    while (runtime.inputs.length === 0) {
      await tick();
    }
    const second = forwardInput(daemon, {
      adapter: "codex",
      text: "second prompt",
      conversationId: "conv-2",
    });
    // The adapter only becomes busy after the first input was submitted; the
    // serialization chain must let the second request observe that.
    runtime.setStatus("busy");
    runtime.releaseInput();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({
      forwarded: true,
      adapter: "codex",
      conversationId: "conv-1",
    });
    expect(secondResult.forwarded).toBe(false);
    expect(secondResult.reason).toBe("busy");
    expect(runtime.inputs).toEqual(["first prompt"]);
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-1");
    expect(env.wecom.sent.map((message) => message.target.conversationId)).toContain("conv-2");
  });

  test("treats an active daemon task as busy even before runtime status catches up", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    await forwardInput(daemon, {
      adapter: "codex",
      text: "first prompt",
      conversationId: "conv-1",
    });
    const result = await forwardInput(daemon, {
      adapter: "codex",
      text: "second prompt",
      conversationId: "conv-2",
    });

    expect(result.reason).toBe("busy");
    expect(env.runtime("codex").inputs).toEqual(["first prompt"]);
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-1");
  });
});

describe("wechat-daemon handlers: failure rollback", () => {
  test("rolls back task and conversation refs when sendInput fails", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    // Bring the slot up without submitting anything.
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "codex",
      cwd: TEST_CWD,
      openVisible: false,
    });
    const runtime = env.runtime("codex");
    const error = new Error("pty write failed");
    runtime.failNextInput(error);

    const failure = await expectRejection(
      forwardInput(daemon, {
        adapter: "codex",
        text: "doomed prompt",
        conversationId: "conv-1",
      }),
    );
    expect(failure.message).toBe("pty write failed");

    expect(daemon.getSlotState("codex")?.hasActiveTask).toBe(false);
    expect(daemon.getSlotState("codex")?.activeConversationId).toBeUndefined();
    expect(daemon.getSlotState("codex")?.lastConversationId).toBeUndefined();

    // The rolled-back global conversation still points at the daemon default,
    // not at the failed request's conversation: a slot-scoped notice with no
    // refs of its own falls back to it.
    runtime.emit(notice("post-failure notice"));
    await tick(20);
    const forwarded = env.wecom.sent.find((message) =>
      message.text.includes("post-failure notice"),
    );
    expect(forwarded).toBeDefined();
    expect(forwarded!.target.conversationId).toBe(OPERATOR_ID);

    // No residual dirty state: a follow-up request succeeds normally.
    const retry = await forwardInput(daemon, {
      adapter: "codex",
      text: "retry prompt",
      conversationId: "conv-retry",
    });
    expect(retry).toEqual({
      forwarded: true,
      adapter: "codex",
      conversationId: "conv-retry",
    });
    expect(runtime.inputs.at(-1)).toBe("retry prompt");
  });

  test("restores active adapter when a non-active target rejects input", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");
    await forwardInput(daemon, {
      adapter: "codex",
      text: "codex prompt",
      conversationId: "conv-codex",
    });
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "claude",
      cwd: TEST_CWD,
      openVisible: false,
    });
    await daemon.handleDaemonRequest({
      command: "ensure_slot",
      adapter: "codex",
      cwd: TEST_CWD,
      openVisible: false,
    });
    env.runtime("claude").failNextInput(new Error("claude submit failed"));

    await expectRejection(
      forwardInput(daemon, {
        adapter: "claude",
        text: "failed claude prompt",
        conversationId: "conv-claude",
      }),
    );

    expect(daemon.getStatus().activeAdapter).toBe("codex");
    expect(daemon.getSlotState("claude")?.activeConversationId).toBeUndefined();
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-codex");
  });
});

describe("wechat-daemon handlers: WeCom conversation routing", () => {
  test("routes a non-active adapter's output to its own conversation", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    // A turn on codex, then a turn on claude (which becomes the active slot).
    await forwardInput(daemon, {
      adapter: "codex",
      text: "codex prompt",
      conversationId: "conv-codex",
    });
    await forwardInput(daemon, {
      adapter: "claude",
      text: "claude prompt",
      conversationId: "conv-claude",
    });

    expect(daemon.getSlotState("claude")?.active).toBe(true);
    expect(daemon.getSlotState("claude")?.activeConversationId).toBe("conv-claude");
    expect(daemon.getSlotState("codex")?.active).toBe(false);
    expect(daemon.getSlotState("codex")?.activeConversationId).toBe("conv-codex");

    // A notice from the non-active codex slot must land in its own
    // conversation, never in the active adapter's conversation.
    env.runtime("codex").emit(notice("codex progress notice"));
    await tick(20);

    const sent = env.wecom.sent.find((message) =>
      message.text.includes("codex progress notice"),
    );
    expect(sent).toBeDefined();
    expect(sent!.target.conversationId).toBe("conv-codex");
    expect(sent!.target.conversationId).not.toBe("conv-claude");
  });

  test("keeps buffered output with the conversation that owned the event", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    await forwardInput(daemon, {
      adapter: "codex",
      text: "codex prompt",
      conversationId: "conv-codex-old",
    });
    env.runtime("codex").emit(stdout("buffered codex output"));
    await tick();

    await forwardInput(daemon, {
      adapter: "claude",
      text: "claude prompt",
      conversationId: "conv-claude",
    });
    await forwardInput(daemon, {
      adapter: "codex",
      text: "codex follow-up",
      conversationId: "conv-codex-new",
    });
    env.runtime("codex").emit(notice("flush buffered codex output"));
    await tick(20);

    const buffered = env.wecom.sent.find((message) =>
      message.text.includes("buffered codex output"),
    );
    expect(buffered).toBeDefined();
    expect(buffered!.target.conversationId).toBe("conv-codex-old");
  });

  test("snapshots final replies and approval errors for a non-active adapter", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    await forwardInput(daemon, {
      adapter: "codex",
      text: "codex prompt",
      conversationId: "conv-codex",
    });
    await forwardInput(daemon, {
      adapter: "claude",
      text: "claude prompt",
      conversationId: "conv-claude",
    });

    env.runtime("codex").emit({
      type: "final_reply",
      text: "codex final reply",
      timestamp: new Date().toISOString(),
    });
    env.runtime("codex").emit({
      type: "approval_required",
      request: pendingApproval,
      timestamp: new Date().toISOString(),
    });
    await tick(20);

    const finalReply = env.wecom.sent.find((message) =>
      message.text.includes("codex final reply"),
    );
    const approval = env.wecom.sent.find((message) =>
      message.text.includes(pendingApproval.commandPreview),
    );
    expect(finalReply?.target.conversationId).toBe("conv-codex");
    expect(approval?.target.conversationId).toBe("conv-codex");

    env.runtime("codex").emit({
      type: "task_failed",
      message: "codex task failed",
      timestamp: new Date().toISOString(),
    });
    await tick(20);
    const failure = env.wecom.sent.find((message) =>
      message.text.includes("codex task failed"),
    );
    expect(failure?.target.conversationId).toBe("conv-codex");
  });

  test("routes fatal errors from a non-active adapter to its saved conversation", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon("wecom");

    await forwardInput(daemon, {
      adapter: "codex",
      text: "codex prompt",
      conversationId: "conv-codex",
    });
    await forwardInput(daemon, {
      adapter: "claude",
      text: "claude prompt",
      conversationId: "conv-claude",
    });
    env.runtime("codex").emit({
      type: "fatal_error",
      message: "codex runtime died",
      timestamp: new Date().toISOString(),
    });
    await tick(20);

    const fatal = env.wecom.sent.find((message) =>
      message.text.includes("codex runtime died"),
    );
    expect(fatal?.target.conversationId).toBe("conv-codex");
  });
});
