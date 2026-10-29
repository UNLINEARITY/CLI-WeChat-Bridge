// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "../../src/i18n/index.ts";
import type {
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeWorkerStatus,
} from "../../src/bridge/bridge-types.ts";
import type { BridgeInboundMessage } from "../../src/core/channel-types.ts";
import type {
  BridgeDaemonDeps,
} from "../../src/daemon/wechat-daemon.ts";
import {
  BridgeDaemon,
} from "../../src/daemon/wechat-daemon.ts";
import type { WeChatTransport } from "../../src/wechat/wechat-transport.ts";
import type { PendingMessageStore } from "../../src/core/pending-message-store.ts";
import type { SlotSessionRecord, SlotSessionStore } from "../../src/daemon/slot-session-store.ts";
import {
  conversationPinKey,
  createFileSlotPins,
  createMemorySlotPins,
  formatPinsListMessage,
  parseMessageTag,
  parsePinCommand,
  parsePinWindowName,
  pinTagKey,
  type ConversationPinTarget,
} from "../../src/daemon/slot-pins.ts";

beforeEach(() => setLocale("en"));

const TEST_CWD = "C:\\Users\\test\\daemon-pins";
const OPERATOR_ID = "operator-001";

type SentWechatMessage = { recipientId: string; text: string };

class FakeWeChatTransport {
  readonly sent: SentWechatMessage[] = [];

  async sendText(recipientId: string, text: string): Promise<void> {
    this.sent.push({ recipientId, text });
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

class FakeBridgeRuntime implements BridgeAdapter {
  readonly adapter: "codex";
  readonly instance: number;
  state: BridgeAdapterState;
  readonly inputs: string[] = [];
  private sink: ((event: BridgeEvent) => void) | null = null;

  constructor(adapter: "codex", cwd: string, command: string, instance = 1) {
    this.adapter = adapter;
    this.instance = instance;
    this.state = {
      kind: adapter,
      status: "idle",
      cwd,
      command,
      sharedThreadId: "thread-visible",
      lastThreadSwitchSource: "local" as const,
    };
  }

  setEventSink(sink: (event: BridgeEvent) => void): void {
    this.sink = sink;
  }

  emit(event: BridgeEvent): void {
    this.sink?.(event);
  }

  async start(): Promise<void> {}
  async sendInput(text: string): Promise<void> {
    this.inputs.push(text);
    // Complete the turn so the slot accepts the next message.
    this.emit({ type: "task_complete", taskId: "t", timestamp: new Date().toISOString() });
  }
  async listResumeSessions(): Promise<[]> {
    return [];
  }
  async resumeSession(): Promise<void> {}
  async interrupt(): Promise<boolean> {
    return true;
  }
  async reset(): Promise<void> {
    this.state = { ...this.state, status: "idle" };
  }
  async resolveApproval(): Promise<boolean> {
    return true;
  }
  async setAutoApproval(): Promise<boolean> {
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

class MemorySessionStore implements SlotSessionStore {
  readonly records = new Map<string, SlotSessionRecord>();

  read(cwd: string, adapter: string): SlotSessionRecord | null {
    return this.records.get(`${cwd}|${adapter}`) ?? null;
  }

  write(cwd: string, adapter: string, record: SlotSessionRecord): void {
    this.records.set(`${cwd}|${adapter}`, record);
  }
}

class FakeDaemonEnvironment {
  readonly wechat = new FakeWeChatTransport();
  readonly runtimes = new Map<string, FakeBridgeRuntime>();
  readonly logs: string[] = [];
  readonly openedVisible: string[] = [];
  visibleAlive = true;

  readonly deps: BridgeDaemonDeps = {
    createRuntime: (params) => {
      const instance = params.slotInstance ?? 1;
      const runtime = new FakeBridgeRuntime(
        params.kind as "codex",
        params.cwd,
        params.command,
        instance,
      );
      this.runtimes.set(`${params.kind}-${instance}`, runtime);
      return runtime;
    },
    openVisibleClient: (params) => {
      this.openedVisible.push(`${params.adapter}-${params.instance ?? 1}`);
      return { command: "fake-visible-client", args: [] };
    },
    isVisibleClientAlive: () => this.visibleAlive,
    daemonLog: (message) => {
      this.logs.push(message);
    },
    pendingMessages: new FakePendingStore() as unknown as PendingMessageStore,
    visibleClientConnectTimeoutMs: 50,
    fatalNoticeGraceMs: 0,
    slotSessions: new MemorySessionStore(),
    slotPins: createMemorySlotPins(),
  };

  buildDaemon(): BridgeDaemon {
    return new BridgeDaemon({
      cwd: TEST_CWD,
      authorizedUserId: OPERATOR_ID,
      transport: this.wechat as unknown as WeChatTransport,
      channelId: "wechat",
      wecomTransport: null,
      deps: this.deps,
    });
  }

  runtime(adapter: string, instance = 1): FakeBridgeRuntime {
    const runtime = this.runtimes.get(`${adapter}-${instance}`);
    if (!runtime) {
      throw new Error(`runtime ${adapter}-${instance} not created`);
    }
    return runtime;
  }
}

function send(
  daemon: BridgeDaemon,
  text: string,
  sessionId = "conv-a",
): Promise<void> {
  return (daemon as unknown as {
    handleInboundMessage(message: BridgeInboundMessage): Promise<void>;
  }).handleInboundMessage({
    senderId: OPERATOR_ID,
    sender: OPERATOR_ID,
    sessionId,
    text,
    attachments: [],
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  });
}

describe("slot pins", () => {
  test("memory store round-trips pins", () => {
    const pins = createMemorySlotPins();
    const key = conversationPinKey("wechat", "conv-1");
    expect(pins.get(key)).toBeUndefined();
    const target: ConversationPinTarget = { cwd: TEST_CWD, adapter: "codex", instance: 2 };
    pins.set(key, target);
    expect(pins.get(key)).toEqual(target);
    expect(pins.list()).toHaveLength(1);
    expect(pins.remove(key)).toBe(true);
    expect(pins.get(key)).toBeUndefined();
    expect(pins.remove(key)).toBe(false);
  });

  test("conversation pin keys combine channel and conversation id", () => {
    expect(conversationPinKey("wechat", "conv-1")).toBe("wechat:conv-1");
  });

  test("parsePinCommand accepts pin, unpin and pins exactly", () => {
    expect(parsePinCommand("/pin")).toEqual({ type: "pin" });
    expect(parsePinCommand("/pin codex")).toEqual({ type: "pin-to", window: "codex" });
    expect(parsePinCommand("/pin codex-2")).toEqual({ type: "pin-to", window: "codex-2" });
    expect(parsePinCommand("/unpin")).toEqual({ type: "unpin" });
    expect(parsePinCommand("/pins")).toEqual({ type: "list" });
    expect(parsePinCommand("/pins now")).toBeNull();
    expect(parsePinCommand("hello")).toBeNull();
  });

  test("parsePinCommand accepts tag pins with and without a window", () => {
    expect(parsePinCommand("/pin [A]")).toEqual({ type: "pin-tag", tag: "A" });
    expect(parsePinCommand("/pin [A] codex-2")).toEqual({
      type: "pin-tag",
      tag: "A",
      window: "codex-2",
    });
    expect(parsePinCommand("/pin [work] claude")).toEqual({
      type: "pin-tag",
      tag: "work",
      window: "claude",
    });
    expect(parsePinCommand("/pin [任务]")).toEqual({ type: "pin-tag", tag: "任务" });
    expect(parsePinCommand("/unpin [A]")).toEqual({ type: "unpin-tag", tag: "A" });
    expect(parsePinCommand("/unpin [A] extra")).toBeNull();
    expect(parsePinCommand("/pin [a] [b]")).toEqual({
      type: "pin-tag",
      tag: "a",
      window: "[b]",
    });
    // Over-length tags fall back to a window-name pin, which the window
    // parser then rejects with pin.invalidWindow.
    expect(parsePinCommand("/pin [abcdefghijklmnop] codex")).toEqual({
      type: "pin-to",
      window: "[abcdefghijklmnop] codex",
    });
  });

  test("parseMessageTag extracts a leading tag and keeps the remainder", () => {
    expect(parseMessageTag("[A] deploy now")).toEqual({ tag: "A", remainder: "deploy now" });
    expect(parseMessageTag("[A]deploy now")).toEqual({ tag: "A", remainder: "deploy now" });
    expect(parseMessageTag("  [task-1]  run tests  ")).toEqual({
      tag: "task-1",
      remainder: "run tests  ",
    });
    expect(parseMessageTag("[工作] 写周报")).toEqual({ tag: "工作", remainder: "写周报" });
    // A bare tag with no content, nested brackets and missing brackets stay plain.
    expect(parseMessageTag("[A]")).toBeNull();
    expect(parseMessageTag("[[A]] text")).toBeNull();
    expect(parseMessageTag("A] text")).toBeNull();
    expect(parseMessageTag("text [A] tail")).toBeNull();
  });

  test("pinTagKey normalizes tags to upper case", () => {
    expect(pinTagKey("wechat:conv-a", "A")).toBe("wechat:conv-a#A");
    expect(pinTagKey("wechat:conv-a", "a")).toBe("wechat:conv-a#A");
    expect(pinTagKey("wechat:conv-a", "work")).toBe("wechat:conv-a#WORK");
  });

  test("formatPinsListMessage lists pins with window names", () => {
    const pins = [
      { key: "wechat:conv-a", target: { cwd: TEST_CWD, adapter: "codex", instance: 1 } },
    ];
    const text = formatPinsListMessage(pins, (target) => `codex-${target.instance}`);
    expect(text).toContain("conv-a");
    expect(text).toContain("codex-1");
    expect(formatPinsListMessage([], () => "")).toContain("No chats");
  });

  test("parsePinWindowName accepts valid window names and rejects others", () => {
    expect(parsePinWindowName("codex")).toEqual({ adapter: "codex", instance: 1 });
    expect(parsePinWindowName("codex-2")).toEqual({ adapter: "codex", instance: 2 });
    expect(parsePinWindowName("codex-99")).toEqual({ adapter: "codex", instance: 99 });
    expect(parsePinWindowName("CODEX-2")).toEqual({ adapter: "codex", instance: 2 });
    expect(parsePinWindowName("codex-2 ")).toEqual({ adapter: "codex", instance: 2 });
    expect(parsePinWindowName("claude")).toEqual({ adapter: "claude", instance: 1 });
    expect(parsePinWindowName("pi-3")).toEqual({ adapter: "pi", instance: 3 });
    expect(parsePinWindowName("opencode")).toEqual({ adapter: "opencode", instance: 1 });
    // Unknown adapters, zero instances, too-large instances and junk are rejected.
    expect(parsePinWindowName("bogus")).toBeNull();
    expect(parsePinWindowName("codex-0")).toBeNull();
    expect(parsePinWindowName("codex-100")).toBeNull();
    expect(parsePinWindowName("codex--2")).toBeNull();
    expect(parsePinWindowName("")).toBeNull();
  });

  test("file pins persist across instances and survive malformed input", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-test-"));
    try {
      const pinsFile = path.join(dir, "pins.json");
      const first = createFileSlotPins(pinsFile);
      const key = conversationPinKey("wechat", "conv-1");
      first.set(key, { cwd: TEST_CWD, adapter: "codex", instance: 2 });

      // A fresh instance re-reads the same file.
      const second = createFileSlotPins(pinsFile);
      expect(second.get(key)).toEqual({ cwd: TEST_CWD, adapter: "codex", instance: 2 });
      expect(second.list()).toHaveLength(1);

      // Removing persists too.
      expect(second.remove(key)).toBe(true);
      const third = createFileSlotPins(pinsFile);
      expect(third.get(key)).toBeUndefined();

      // A corrupt file falls back to an empty store instead of crashing.
      fs.writeFileSync(pinsFile, "{ not json");
      const broken = createFileSlotPins(pinsFile);
      expect(broken.list()).toHaveLength(0);
      broken.set(key, { cwd: TEST_CWD, adapter: "codex", instance: 1 });
      expect(broken.get(key)).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon conversation pinning", () => {
  afterEach(() => setLocale("en"));

  test("/pin without any window replies with the no-active-slot message", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();
    await send(daemon, "/pin");
    expect(env.wechat.sent.some((m) => m.text.includes("No window to pin"))).toBe(true);
    expect(env.deps.slotPins!.list()).toHaveLength(0);
  });

  test("pinned conversations route to their window even after switching away", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    // Open codex window #1 (switch directive creates the first slot).
    await send(daemon, "/codex");
    expect(env.runtime("codex", 1)).toBeDefined();

    // Open a second codex window; it becomes active.
    await send(daemon, "/open");
    const codex2 = env.runtime("codex", 2);
    expect(codex2).toBeDefined();

    // Pin the conversation to the current window (codex-2).
    await send(daemon, "/pin");
    const key = conversationPinKey("wechat", "conv-a");
    expect(env.deps.slotPins!.get(key)).toEqual({
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 2,
    });
    expect(env.logs.some((line) => line.startsWith("conversation_pinned:"))).toBe(true);

    // Switch back to codex-1; a plain message must still go to codex-2.
    await send(daemon, "/1");
    expect(env.runtime("codex", 1)).toBeDefined();
    await send(daemon, "pinned-msg");
    expect(codex2.inputs).toContain("pinned-msg");
    expect(env.runtime("codex", 1).inputs).not.toContain("pinned-msg");

    // A second message keeps following the pin.
    await send(daemon, "pinned-msg-2");
    expect(codex2.inputs).toContain("pinned-msg-2");
  });

  test("a different conversation is not affected by another conversation's pin", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex", "conv-a");
    await send(daemon, "/pin", "conv-a");
    await send(daemon, "/open", "conv-a");

    // conv-b is not pinned: it follows the active window (codex-2).
    await send(daemon, "from-conv-b", "conv-b");
    expect(env.runtime("codex", 2).inputs).toContain("from-conv-b");
  });

  test("/unpin restores active-slot routing for the conversation", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/open");
    await send(daemon, "/pin");
    await send(daemon, "/1");
    await send(daemon, "before-unpin");
    expect(env.runtime("codex", 2).inputs).toContain("before-unpin");

    await send(daemon, "/unpin");
    const key = conversationPinKey("wechat", "conv-a");
    expect(env.deps.slotPins!.get(key)).toBeUndefined();

    await send(daemon, "after-unpin");
    expect(env.runtime("codex", 1).inputs).toContain("after-unpin");
    expect(env.runtime("codex", 2).inputs).not.toContain("after-unpin");
  });

  test("/pins lists the pinned conversations of the channel", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/pin");
    await send(daemon, "/pins");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply).toContain("conv-a");
    expect(reply).toContain("codex");
  });

  test("/pin <window> pins to the named window even when another is active", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    // codex-1 is the active window.
    await send(daemon, "/codex");

    // Pin to codex-2 (creates it if missing).
    await send(daemon, "/pin codex-2");
    const key = conversationPinKey("wechat", "conv-a");
    expect(env.deps.slotPins!.get(key)).toEqual({
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 2,
    });
    expect(env.runtime("codex", 2)).toBeDefined();

    // Messages follow the pin, not the active window.
    await send(daemon, "to-codex-2");
    expect(env.runtime("codex", 2).inputs).toContain("to-codex-2");
    expect(env.runtime("codex", 1).inputs).not.toContain("to-codex-2");
  });

  test("/pin <window> rejects unknown window names", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/pin bogus");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply.toLowerCase()).toContain("unknown window");
    // Only the auto-registered session of the codex window exists; nothing pinned.
    const pinKeys = env.deps.slotPins!.list().map((pin) => pin.key);
    expect(pinKeys.some((key) => key.includes("#"))).toBe(true);
    expect(pinKeys.some((key) => key.endsWith(":conv-a"))).toBe(false);
  });

  test("/pin <window> followed by /unpin falls back to active routing", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    // /open upgrades the bridge to multi_instance so numbered /1 switching
    // is available; /pin codex-2 then reuses the existing second window.
    await send(daemon, "/codex");
    await send(daemon, "/open");
    await send(daemon, "/pin codex-2");
    await send(daemon, "/1");
    await send(daemon, "/unpin");
    const key = conversationPinKey("wechat", "conv-a");
    expect(env.deps.slotPins!.get(key)).toBeUndefined();

    await send(daemon, "after-unpin");
    expect(env.runtime("codex", 1).inputs).toContain("after-unpin");
    expect(env.runtime("codex", 2).inputs).not.toContain("after-unpin");
  });

  test("/pins shows the window name a conversation was pinned to", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/pin codex-2");
    await send(daemon, "/pins");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply).toContain("conv-a");
    expect(reply).toContain("codex-2");
  });

  test("a pin from another channel does not route this channel's messages", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    // Pin the same conversation key shape under a different channel prefix.
    env.deps.slotPins!.set(conversationPinKey("telegram", "conv-a"), {
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 2,
    });

    // The wechat conversation is unpinned: it follows the active window.
    await send(daemon, "/codex");
    await send(daemon, "wechat-msg");
    expect(env.runtime("codex", 1).inputs).toContain("wechat-msg");
    expect(env.deps.slotPins!.get(conversationPinKey("wechat", "conv-a"))).toBeUndefined();
  });

  test("/pin <window> to a missing window upgrades the mode so numbered switching works", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    // A single codex window (mode: single). /pin codex-2 must take the
    // standard new-window path: the bridge upgrades to multi_instance and
    // /1, /2 become available instead of leaving the operator stuck.
    await send(daemon, "/codex");
    await send(daemon, "/pin codex-2");
    await send(daemon, "/1");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply).not.toContain("not available in this mode");

    // The pin still wins over the now-active codex-1.
    await send(daemon, "pinned-msg");
    expect(env.runtime("codex", 2).inputs).toContain("pinned-msg");
    expect(env.runtime("codex", 1).inputs).not.toContain("pinned-msg");

    // /1 did switch back to codex-1: after unpinning, the message follows it.
    await send(daemon, "/unpin");
    await send(daemon, "after-unpin");
    expect(env.runtime("codex", 1).inputs).toContain("after-unpin");
    expect(env.runtime("codex", 2).inputs).not.toContain("after-unpin");
  });

  test("/pin <window> to a gap in the numbering keeps explicit creation without mode upgrade", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    // codex-2 is the next free instance, so /pin codex-3 targets a gap: the
    // window is created exactly as named, but the mode is left untouched and
    // /1 stays unavailable (consistent with the mode semantics).
    await send(daemon, "/codex");
    await send(daemon, "/pin codex-3");
    await send(daemon, "/1");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply).toContain("not available in this mode");

    // The exact instance was created and pinned.
    await send(daemon, "pinned-msg");
    expect(env.runtime("codex", 3).inputs).toContain("pinned-msg");
    expect(env.runtime("codex", 1).inputs).not.toContain("pinned-msg");
  });

  test("/pin [tag] pins the current window and routes tagged messages to it", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/pin [A]");
    expect(env.deps.slotPins!.get(pinTagKey("wechat:conv-a", "A"))).toEqual({
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 1,
    });

    // The tag prefix is stripped before the prompt reaches the CLI.
    await send(daemon, "[A] hello task");
    expect(env.runtime("codex", 1).inputs).toContain("hello task");
    expect(env.runtime("codex", 1).inputs).not.toContain("[A]");

    // A tagged pin matches case-insensitively.
    await send(daemon, "[a] lowercase tag");
    expect(env.runtime("codex", 1).inputs).toContain("lowercase tag");
  });

  test("/pin [tag] <window> opens the window, upgrades the mode and routes there", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/pin [A] codex-2");
    expect(env.deps.slotPins!.get(pinTagKey("wechat:conv-a", "A"))).toEqual({
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 2,
    });

    // Mode upgraded with the new window: /1 is available again.
    await send(daemon, "/1");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply).not.toContain("not available in this mode");

    // Tagged messages go to codex-2 even while codex-1 is active.
    await send(daemon, "[A] tagged task");
    expect(env.runtime("codex", 2).inputs).toContain("tagged task");
    expect(env.runtime("codex", 1).inputs).not.toContain("tagged task");
  });

  test("a tag pin wins over the conversation pin; /unpin [tag] falls back to it", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex"); // codex-1 active, mode single
    await send(daemon, "/pin"); // conversation pin → codex-1
    await send(daemon, "/open"); // codex-2 active, mode multi_instance
    await send(daemon, "/pin [A] codex-2"); // tag pin → codex-2
    await send(daemon, "/1"); // switch back to codex-1

    await send(daemon, "[A] tagged msg");
    expect(env.runtime("codex", 2).inputs).toContain("tagged msg");
    expect(env.runtime("codex", 1).inputs).not.toContain("tagged msg");

    // Untagged messages follow the conversation pin (codex-1).
    await send(daemon, "plain msg");
    expect(env.runtime("codex", 1).inputs).toContain("plain msg");
    expect(env.runtime("codex", 2).inputs).not.toContain("plain msg");

    // Unpinning the tag falls back to the conversation pin; the tag prefix
    // is no longer stripped because nothing is bound to it.
    await send(daemon, "/unpin [A]");
    await send(daemon, "[A] after unpin");
    expect(env.runtime("codex", 1).inputs).toContain("[A] after unpin");
    expect(env.runtime("codex", 2).inputs).not.toContain("after unpin");
  });

  test("/pins lists tag pins as [tag] → window", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex");
    await send(daemon, "/pin [A] codex-2");
    await send(daemon, "/pins");
    const reply = env.wechat.sent.at(-1)?.text ?? "";
    expect(reply).toContain("[A]");
    expect(reply).toContain("codex-2");
  });
});

describe("auto sessions", () => {
  const base = path.basename(TEST_CWD);

  test("a new window registers itself as a cwd-named session and routes [name] messages", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex", OPERATOR_ID);
    expect(env.deps.slotPins!.get(pinTagKey(`wechat:${OPERATOR_ID}`, base))).toEqual({
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 1,
    });
    const notices = env.wechat.sent.map((m) => m.text);
    expect(notices.some((text) => text.includes(base))).toBe(true);

    // A second window in the same directory gets a suffixed session name.
    await send(daemon, "/open", OPERATOR_ID);
    const suffixed = `${base.slice(0, 10)}-2`.slice(0, 12);
    expect(env.deps.slotPins!.get(pinTagKey(`wechat:${OPERATOR_ID}`, suffixed))).toEqual({
      cwd: TEST_CWD,
      adapter: "codex",
      instance: 2,
    });

    // [name] routes to its window and strips the prefix; [name-2] to the other.
    await send(daemon, `[${base}] hello one`, OPERATOR_ID);
    expect(env.runtime("codex", 1).inputs).toContain("hello one");
    expect(env.runtime("codex", 1).inputs).not.toContain(`[${base}]`);
    expect(env.runtime("codex", 2).inputs).not.toContain("hello one");

    await send(daemon, `[${suffixed}] hello two`, OPERATOR_ID);
    expect(env.runtime("codex", 2).inputs).toContain("hello two");
    expect(env.runtime("codex", 1).inputs).not.toContain("hello two");

    // A bare [name] reports the window instead of routing an empty prompt.
    await send(daemon, `[${base}]`, OPERATOR_ID);
    const status = env.wechat.sent.at(-1)?.text ?? "";
    expect(status).toContain(base);
    expect(env.runtime("codex", 1).inputs).toHaveLength(1);
  });

  test("closing the window unregisters its session", async () => {
    const env = new FakeDaemonEnvironment();
    const daemon = env.buildDaemon();

    await send(daemon, "/codex", OPERATOR_ID);
    expect(env.deps.slotPins!.get(pinTagKey(`wechat:${OPERATOR_ID}`, base))).toBeDefined();

    const slot = daemon.slots.get("codex")!;
    const manager = (daemon as unknown as { slotManager: { releaseSlot(s: unknown): Promise<void> } })
      .slotManager;
    await manager.releaseSlot(slot);

    expect(env.deps.slotPins!.get(pinTagKey(`wechat:${OPERATOR_ID}`, base))).toBeUndefined();
    const notice = env.wechat.sent.at(-1)?.text ?? "";
    expect(notice).toContain("unregistered");
  });
});
