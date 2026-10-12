// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { setLocale } from "../../src/i18n/index.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { OpenCodeServerAdapter } from "../../src/bridge/bridge-adapters.opencode.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import { buildClaudeHookSettings } from "../../src/bridge/claude-hooks.ts";
import { normalizeOpenCodeV2Event } from "../../src/bridge/opencode-v2-compat.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";
import { handleInboundMessage, wireAdapterEvents } from "../../src/bridge/wechat-bridge.ts";

beforeEach(() => setLocale("en"));

function codex() {
  const adapter = createBridgeAdapter({ kind: "codex", command: "codex", cwd: process.cwd(), renderMode: "panel" }) as any;
  const events: BridgeEvent[] = [];
  const replies: any[] = [];
  adapter.setEventSink((event: BridgeEvent) => events.push(event));
  adapter.sendRpcMessage = (reply: unknown) => replies.push(reply);
  adapter.activeTurn = { threadId: "parent", turnId: "parent-turn", origin: "wechat" };
  adapter.state.status = "busy";
  adapter.state.activeTurnId = "parent-turn";
  adapter.state.activeTurnOrigin = "wechat";
  const ask = (id: string | number, threadId = "parent", turnId = "parent-turn") => adapter.handleRpcServerRequest(id,
    "item/commandExecution/requestApproval", { threadId, turnId, command: "rm -rf /tmp/approval-test" });
  return { adapter, events, replies, ask };
}

function opencode() {
  const adapter = new OpenCodeServerAdapter({ kind: "opencode", command: "opencode", cwd: process.cwd() }) as any;
  const events: BridgeEvent[] = [];
  const replies: any[] = [];
  adapter.setEventSink((event: BridgeEvent) => events.push(event));
  adapter.activeSessionId = "parent";
  adapter.state.status = "busy";
  adapter.state.activeTurnOrigin = "wechat";
  adapter.client = { permission: { reply: async (reply: unknown) => { replies.push(reply); return { data: true }; } } };
  const ask = (id: string, sessionID = "parent") => adapter.handleSseEvent({ type: "permission.asked",
    properties: { id, sessionID, permission: "bash", metadata: { command: "rm -rf /tmp/approval-test" } } });
  return { adapter, events, replies, ask };
}

function claude() {
  const adapter = createBridgeAdapter({ kind: "claude", command: "claude", cwd: process.cwd(), renderMode: "companion" }) as any;
  const events: BridgeEvent[] = [];
  const replies: any[] = [];
  adapter.setEventSink((event: BridgeEvent) => events.push(event));
  adapter.state.status = "busy";
  adapter.state.activeTurnOrigin = "wechat";
  const ask = (id: string, socket = { end: (reply: string) => replies.push(JSON.parse(reply)), destroy() {} }) =>
    adapter.handleClaudePermissionRequest(id, { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/approval-test" } }, socket);
  return { adapter, events, replies, ask };
}


describe("approval queues", () => {
  for (const [name, make] of [["Codex", codex], ["OpenCode", opencode], ["Claude", claude]] as const) {
    test(`${name} promotes one request at a time and rejects a settled ID`, async () => {
      const { adapter, events, replies, ask } = make();
      ask("first");
      const first = adapter.getState().pendingApproval.requestId;
      ask("second");
      ask("first");
      expect(adapter.getState().pendingApprovals).toHaveLength(2);
      expect(adapter.getState().pendingApproval.requestId).toBe(first);
      expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);
      expect(await adapter.resolveApproval("confirm", first)).toBe(true);
      expect(replies).toHaveLength(1);
      expect(adapter.getState().status).toBe("awaiting_approval");
      const second = adapter.getState().pendingApproval.requestId;
      expect(second).not.toBe(first);
      expect(await adapter.resolveApproval("confirm", first)).toBe(false);
      expect(replies).toHaveLength(1);
      expect(await adapter.resolveApproval("deny", second)).toBe(true);
      expect(adapter.getState().pendingApprovals).toEqual([]);
      expect(adapter.getState().pendingApproval).toBeNull();
      expect(adapter.getState().status).toBe("busy");
      expect(events.filter((event) => event.type === "approval_required")).toHaveLength(2);
    });
  }

  for (const [name, make, clear] of [["Codex", codex, "clearPendingApprovalState"], ["OpenCode", opencode, "clearPendingPermissionState"]] as const) {
    test(`${name} does not restore cancelled requests from late duplicate events`, () => {
      const { adapter, ask } = make();
      ask("cancelled");
      adapter[clear]();
      ask("cancelled");
      expect(adapter.getState().pendingApprovals).toEqual([]);
      ask("new-request");
      expect(adapter.getState().pendingApprovals).toHaveLength(1);
    });
  }

  test("OpenCode local settlement removes exactly the matching V1/V2 permission", async () => {
    const { adapter, replies, ask } = opencode();
    ask("first"); ask("second");
    adapter.handleSseEvent({ type: "permission.replied", properties: { sessionID: "other", requestID: "first" } });
    expect(adapter.getState().pendingApprovals).toHaveLength(2);
    adapter.handleSseEvent(normalizeOpenCodeV2Event({ type: "permission.replied", data: { sessionID: "parent", requestID: "second", reply: "once" } })[0]);
    expect(adapter.getState().pendingApproval.requestId).toBe("first");
    expect(adapter.getState().status).toBe("awaiting_approval");
    adapter.handleSseEvent({ type: "permission.replied", properties: { sessionID: "parent", requestID: "first" } });
    expect(await adapter.resolveApproval("confirm", "first")).toBe(false);
    expect(replies).toEqual([]);
    expect(adapter.getState().pendingApprovals).toEqual([]);
  });

  test("OpenCode retains failed replies and prevents duplicate concurrent writes", async () => {
    const { adapter, ask } = opencode();
    ask("first"); ask("second");
    let finish!: (value: unknown) => void;
    adapter.client.permission.reply = () => new Promise((resolve) => { finish = resolve; });
    const resolving = adapter.resolveApproval("confirm", "first");
    expect(await adapter.resolveApproval("confirm", "first")).toBe(false);
    finish({ error: "offline" });
    expect(await resolving).toBe(false);
    expect(adapter.getState().pendingApproval.requestId).toBe("first");
    expect(adapter.getState().pendingApprovals).toHaveLength(2);
  });

  test("OpenCode child and nested child permissions use their source session without following it", async () => {
    const { adapter, replies, ask } = opencode();
    for (const [id, parentID, directory] of [["child", "parent", process.cwd()], ["nested", "child", process.cwd()], ["other", "elsewhere", process.cwd()], ["foreign", "parent", "/other-project"]]) {
      adapter.handleSseEvent({ type: "session.created", properties: { info: { id, parentID, directory } } });
    }
    ask("child-request", "nested"); ask("unrelated", "other"); ask("foreign-request", "foreign");
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
    expect(adapter.activeSessionId).toBe("parent");
    expect(adapter.getState().activeTurnOrigin).toBe("wechat");
    expect(await adapter.resolveApproval("confirm", "child-request")).toBe(true);
    expect(replies[0]).toMatchObject({ requestID: "child-request", sessionID: "nested" });
  });

  test("Codex distinguishes numeric and string RPC IDs and local resolution preserves the remaining head", async () => {
    const { adapter, replies, ask } = codex();
    ask(1); ask("1");
    const first = adapter.getState().pendingApprovals[0].requestId;
    const second = adapter.getState().pendingApprovals[1].requestId;
    expect(first).not.toBe(second);
    adapter.handleRpcNotification("serverRequest/resolved", { threadId: "parent", turnId: "parent-turn", requestId: "1" });
    expect(adapter.getState().pendingApproval.requestId).toBe(first);
    expect(adapter.getState().status).toBe("awaiting_approval");
    expect(await adapter.resolveApproval("deny", second)).toBe(false);
    expect(await adapter.resolveApproval("confirm", first)).toBe(true);
    expect(replies[0]).toMatchObject({ id: 1, result: { decision: "accept" } });
  });

  test("Codex forwards nested child approvals to the parent and settles child requests locally", () => {
    const { adapter, ask } = codex();
    adapter.rememberBackgroundThread({ id: "child", parentThreadId: "parent" });
    adapter.rememberBackgroundThread({ id: "nested", parentThreadId: "child" });
    ask("child-request", "nested", "child-turn");
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
    expect(adapter.activeTurn).toEqual({ threadId: "parent", turnId: "parent-turn", origin: "wechat" });
    adapter.handleRpcNotification("serverRequest/resolved", { threadId: "nested", turnId: "child-turn", requestId: "child-request" });
    expect(adapter.getState().pendingApprovals).toEqual([]);
    expect(adapter.getState().activeTurnId).toBe("parent-turn");
  });

  test("Codex retains a request when its RPC write fails", async () => {
    const { adapter, ask } = codex();
    ask("first");
    const id = adapter.getState().pendingApproval.requestId;
    adapter.sendRpcMessage = () => { throw new Error("disconnected"); };
    await expect(adapter.resolveApproval("confirm", id)).rejects.toThrow("disconnected");
    expect(adapter.getState().pendingApproval.requestId).toBe(id);
  });

  test("Codex discovers verified child ownership when thread metadata was missed", async () => {
    const { adapter, ask } = codex();
    adapter.rpcSocket = {};
    adapter.sendRpcRequest = async (_method: string, { threadId }: { threadId: string }) => ({ thread: { id: threadId, parentThreadId: "parent", cwd: process.cwd() } });
    ask("child-request", "child", "child-turn");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
    expect(adapter.pendingApprovalRequests[0]).toMatchObject({ threadId: "child", turnId: "child-turn", ownerTurnId: "parent-turn" });
    expect(adapter.activeTurn.threadId).toBe("parent");
    adapter.clearPendingApprovalState();
    expect(adapter.getState().pendingApprovals).toEqual([]);
  });

  test("Codex discards an ownership lookup settled locally before it completes", async () => {
    const { adapter, ask } = codex();
    adapter.rpcSocket = {};
    let finish!: (value: unknown) => void;
    adapter.sendRpcRequest = () => new Promise((resolve) => { finish = resolve; });
    ask("child-request", "child", "child-turn");
    adapter.handleRpcNotification("serverRequest/resolved", { threadId: "child", turnId: "child-turn", requestId: "child-request" });
    finish({ thread: { id: "child", parentThreadId: "parent", cwd: process.cwd() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getState().pendingApprovals).toEqual([]);
  });

  test("Codex rejects foreign child ownership and preserves pending input after approvals", async () => {
    const { adapter, ask, replies } = codex();
    adapter.rpcSocket = {};
    adapter.sendRpcRequest = async () => ({ thread: { id: "foreign", parentThreadId: "parent", cwd: "/another-project" } });
    ask("foreign-request", "foreign", "foreign-turn");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getState().pendingApprovals).toEqual([]);
    expect(replies[0]).toMatchObject({ id: "foreign-request", error: { code: -32602 } });
    ask("parent-request");
    adapter.state.pendingUserInput = { summary: "Choose", questions: [] };
    await adapter.resolveApproval("deny", adapter.getState().pendingApproval.requestId);
    expect(adapter.getState().status).toBe("awaiting_input");
  });

  test("OpenCode does not resurrect a permission lookup after clearing its turn", async () => {
    const { adapter, ask } = opencode();
    let finish!: (value: unknown) => void;
    adapter.client.session = { get: () => new Promise((resolve) => { finish = resolve; }) };
    ask("child-request", "child");
    adapter.clearPendingPermissionState();
    finish({ data: { id: "child", parentID: "parent", directory: process.cwd() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getState().pendingApprovals).toEqual([]);
  });

  test("OpenCode deletes queued descendant requests when their parent child session is removed", () => {
    const { adapter, ask } = opencode();
    adapter.handleSseEvent({ type: "session.created", properties: { info: { id: "child", parentID: "parent" } } });
    adapter.handleSseEvent({ type: "session.created", properties: { info: { id: "nested", parentID: "child" } } });
    ask("child-request", "nested"); ask("parent-request");
    adapter.handleSseEvent({ type: "session.deleted", properties: { info: { id: "child" } } });
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
    expect(adapter.getState().pendingApproval.requestId).toBe("parent-request");
    expect(adapter.activeSessionId).toBe("parent");
  });

  test("Claude removes a closed hook without using another request's terminal hints", async () => {
    const { adapter, replies, ask } = claude();
    ask("first"); ask("second");
    adapter.handleClosedClaudeHookApproval("first");
    expect(adapter.getState().pendingApproval.requestId).toBe("second");
    expect(await adapter.resolveApproval("confirm", "first")).toBe(false);
    expect(replies).toEqual([]);
    expect(await adapter.resolveApproval("confirm", "second")).toBe(true);
    expect(replies[0].requestId).toBe("second");
  });

  test("Claude keeps the queue after a hook write failure", async () => {
    const { adapter, ask } = claude();
    ask("first", { end() { throw new Error("offline"); }, destroy() {} });
    expect(await adapter.resolveApproval("confirm", "first")).toBe(false);
    expect(adapter.getState().pendingApproval.requestId).toBe("first");
  });

  test("Claude writes matching decisions to separate real hook sockets", async () => {
    const { adapter } = claude();
    const sockets: net.Socket[] = [];
    const clients: net.Socket[] = [];
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const responses: Promise<any>[] = [];
    try {
      for (const id of ["first", "second"]) {
        const connected = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
        const client = net.connect({ host: "127.0.0.1", port });
        clients.push(client);
        responses.push(new Promise((resolve) => client.once("data", (data) => resolve(JSON.parse(data.toString())))));
        const socket = await connected;
        sockets.push(socket);
        adapter.handleClaudePermissionRequest(id, { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/approval-test" } }, socket);
      }
      expect(await adapter.resolveApproval("confirm", "first")).toBe(true);
      expect((await responses[0]).requestId).toBe("first");
      expect(adapter.getState().pendingApproval.requestId).toBe("second");
      expect(await adapter.resolveApproval("deny", "second")).toBe(true);
      const second = await responses[1];
      expect(second.requestId).toBe("second");
      expect(JSON.parse(second.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
    } finally {
      for (const socket of [...sockets, ...clients]) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("Claude non-strict network settings use the documented WebFetch wildcard rule", () => {
    expect(buildClaudeHookSettings("hook", {})).toMatchObject({ permissions: { allow: ["WebFetch(domain:*)"] } });
    expect(buildClaudeHookSettings("hook", { CLI_BRIDGE_STRICT_APPROVAL: "1" })).not.toHaveProperty("permissions");
    expect(buildClaudeHookSettings("hook", {})).not.toHaveProperty("sandbox");
  });

  test("old companions must be restarted before approving remotely", async () => {
    const adapter = new LocalCompanionProxyAdapter({ kind: "claude", command: "claude", cwd: process.cwd() }) as any;
    let command: unknown;
    adapter.sendRequest = async (payload: unknown) => { command = payload; return true; };
    await expect(adapter.resolveApproval("confirm", "first")).rejects.toThrow("Restart");
    expect(command).toBeUndefined();
    adapter.state.supportsApprovalRequestIds = true;
    expect(await adapter.resolveApproval("deny", "first")).toBe(true);
    expect(command).toEqual({ command: "resolve_approval", action: "deny", requestId: "first" });
  });

  test("companion state precedes a recovered popup and duplicate events do not repeat it", () => {
    const adapter = new LocalCompanionProxyAdapter({ kind: "claude", command: "claude", cwd: process.cwd() }) as any;
    const seen: any[] = [];
    adapter.setEventSink((event: BridgeEvent) => seen.push({ event, state: adapter.getState() }));
    const request = { source: "cli", requestId: "first", summary: "Permission", commandPreview: "command" };
    adapter.handlePanelMessage({ type: "state", state: { kind: "claude", command: "claude", cwd: process.cwd(), status: "awaiting_approval", pendingApprovals: [request], pendingApproval: request, supportsApprovalRequestIds: true } });
    adapter.handlePanelMessage({ type: "event", event: { type: "approval_required", request, timestamp: "now" } });
    expect(seen.filter(({ event }) => event.type === "approval_required")).toHaveLength(1);
    expect(seen.at(-1).state.pendingApproval.requestId).toBe("first");
    adapter.detachPanelSocket();
    expect(adapter.getState().supportsApprovalRequestIds).toBeUndefined();
    expect(adapter.getState().pendingApprovals).toBeUndefined();
  });

  test("OpenCode discovers a child created before SSE attachment and ignores a settled lookup", async () => {
    const { adapter, ask } = opencode();
    let finish!: (value: unknown) => void;
    adapter.client.session = { get: () => new Promise((resolve) => { finish = resolve; }) };
    ask("child-request", "child");
    adapter.handleSseEvent({ type: "permission.replied", properties: { sessionID: "child", requestID: "child-request" } });
    finish({ data: { id: "child", parentID: "parent", directory: process.cwd() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.activeSessionId).toBe("parent");
    expect(adapter.getState().pendingApprovals).toEqual([]);
    ask("next-request", "child");
    expect(adapter.getState().pendingApproval.requestId).toBe("next-request");
  });

  test("Claude permission notifications never reuse a previously auto-approved command", () => {
    const { adapter, events } = claude();
    adapter.handleClaudePermissionRequest("read", { tool_name: "Read", tool_input: { file_path: "/tmp/file" } }, { end() {} });
    adapter.handleClaudeHookEnvelope({ requestId: "notification", rawPayload: JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt" }), socket: { end() {} } });
    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.getState().pendingApproval).toBeNull();
  });

  test("Pi has no remote tool approval queue", async () => {
    const adapter = createBridgeAdapter({ kind: "pi", command: "pi", cwd: process.cwd(), renderMode: "companion" });
    expect(await adapter.resolveApproval("confirm", "missing")).toBe(false);
    expect(await adapter.resolveAllApprovals("deny")).toBe(0);
  });
});

describe("standalone approval routing", () => {
  function bridge() {
    const { adapter, ask } = opencode();
    const sent: string[] = [];
    const tasks: Promise<void>[] = [];
    const state: any = { authorizedUserId: "owner", pendingConfirmation: null };
    const stateStore = {
      getState: () => ({ ...state }),
      setPendingConfirmation: (request: unknown) => { state.pendingConfirmation = request; },
      clearPendingConfirmation: () => { state.pendingConfirmation = null; },
      appendLog() {},
    };
    const options = { adapter: "opencode", channelId: "wechat" };
    const channelDriver = { id: "wechat", capabilities: {}, directConversation: (id: string) => ({ channelId: "wechat", conversationId: id, recipientId: id }) };
    const queueWechatMessage = async (_id: string, text: string) => { sent.push(text); return true; };
    const outputBatcher = { flushNow: async () => undefined };
    wireAdapterEvents({ adapter, options, channelDriver, stateStore, outputBatcher, queueWechatMessage,
      trackWechatForwardTask: (task: Promise<void>) => tasks.push(task), getActiveTask: () => null,
      syncSharedSessionState() {}, syncLocalClientEndpoint() {}, maybeDrainDeferredInboundMessages: async () => undefined,
    } as any);
    const drain = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.all(tasks); };
    const command = async (text: string) => await handleInboundMessage({ adapter, options, channelDriver, stateStore,
      outputBatcher, queueWechatMessage, message: { senderId: "owner", text },
    } as any);
    return { adapter, ask, sent, state, drain, command };
  }

  test("/confirm and /deny resolve only the displayed head and keep the following prompt", async () => {
    const { adapter, ask, sent, state, drain, command } = bridge();
    ask("first"); ask("second");
    await drain();
    expect(state.pendingConfirmation.requestId).toBe("first");
    expect(await command("/confirm")).toBeNull();
    await drain();
    expect(state.pendingConfirmation.requestId).toBe("second");
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
    expect(sent.filter((text) => text.includes("/confirm"))).toHaveLength(2);
    await command("/deny");
    await drain();
    expect(state.pendingConfirmation).toBeNull();
    expect(adapter.getState().pendingApprovals).toEqual([]);
  });

  test("local settlement before a delayed popup is forwarded cannot restore the old prompt", async () => {
    const { adapter, ask, state, drain, command } = bridge();
    ask("first"); ask("second");
    adapter.handleSseEvent({ type: "permission.replied", properties: { sessionID: "parent", requestID: "first" } });
    expect(await command("/confirm")).toBeNull();
    expect(adapter.getState().pendingApproval.requestId).toBe("second");
    await drain();
    expect(state.pendingConfirmation.requestId).toBe("second");
    expect(adapter.getState().pendingApprovals).toHaveLength(1);
  });
});
