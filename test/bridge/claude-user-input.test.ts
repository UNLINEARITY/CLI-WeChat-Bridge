// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import { buildClaudeUserInputRequest, getClaudePermissionAutoResponse } from "../../src/bridge/claude-hooks.ts";
import { formatUserInputRequestMessage, parsePendingUserInputAnswerCommand } from "../../src/bridge/bridge-utils.ts";
import { handleInboundMessage, wireAdapterEvents } from "../../src/bridge/wechat-bridge.ts";
import type { ClaudeHookPayload } from "../../src/bridge/claude-hooks.ts";

const payload = {
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "question-tool",
  tool_input: {
    metadata: { source: "test" },
    questions: [
      { header: "Yes/No", question: "测试 1:这是一个 Yes/No 单选题,要继续吗?", multiSelect: false,
        options: [{ label: "Yes", description: "批准这个操作" }, { label: "No", description: "拒绝这个操作" }] },
      { header: "单选", question: "选择环境", multiSelect: false,
        options: [{ label: "dev", description: "开发" }, { label: "prod", description: "生产" }] },
      { header: "多选", question: "选择功能", multiSelect: true,
        options: [{ label: "A", description: "功能 A" }, { label: "B", description: "功能 B" }] },
      { header: "单选预览", question: "选择界面", multiSelect: false,
        options: [{ label: "简单", description: "简单界面", preview: "┌──────┐\n│ 预览 │\n└──────┘" }, { label: "复杂", description: "复杂界面" }] },
    ],
  },
} as const;

function claude() {
  const adapter = createBridgeAdapter({ kind: "claude", command: "claude", cwd: process.cwd(), renderMode: "companion" }) as any;
  const events: any[] = [];
  const replies: any[] = [];
  adapter.setEventSink((event: any) => events.push(event));
  adapter.state.status = "busy";
  adapter.state.activeTurnOrigin = "wechat";
  const ask = (id: string, input: any = payload, socket: any = { end: (reply: string) => replies.push(JSON.parse(reply)), destroy() {} }) =>
    adapter.handleClaudeHookEnvelope({ requestId: id, rawPayload: JSON.stringify(input), socket });
  return { adapter, events, replies, ask };
}

describe("Claude AskUserQuestion", () => {
  test("forwards all four question types and round-trips answers while preserving tool input", async () => {
    const { adapter, events, replies, ask } = claude();
    ask("first");
    const request = adapter.getState().pendingUserInput;
    expect(adapter.getState()).toMatchObject({ status: "awaiting_input", pendingUserInputOrigin: "wechat" });
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(0);
    expect(replies).toHaveLength(0);
    const pending = { ...request, createdAt: "now" };
    const message = formatUserInputRequestMessage(pending, adapter.getState());
    expect(message).toContain("批准这个操作");
    expect(message).toContain("│ 预览 │");
    const parsed = parsePendingUserInputAnswerCommand("1=Yes;2=2;3=1,2;4=自定义界面", pending);
    expect(parsed).not.toHaveProperty("error");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(await adapter.submitUserInput(parsed.answers, "first")).toBe(true);
    expect(JSON.parse(replies[0].stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { ...payload.tool_input, answers: {
        [payload.tool_input.questions[0].question]: "Yes", "选择环境": "prod", "选择功能": "A, B", "选择界面": "自定义界面",
      } },
    } });
    expect(adapter.getState().pendingUserInput).toBeNull();
    expect(adapter.getState().status).toBe("busy");
  });

  test("single Yes/No, custom text and missing answers are handled without auto-approval", async () => {
    const { adapter, ask } = claude();
    const single = { ...payload, tool_input: { questions: [payload.tool_input.questions[0]] } };
    expect(getClaudePermissionAutoResponse(single as unknown as ClaudeHookPayload, {})).toBeNull();
    ask("first", single);
    expect(await adapter.submitUserInput({}, "first")).toBe(false);
    expect(await adapter.submitUserInput({ q1: ["Yes", "No"] }, "first")).toBe(false);
    const pending = { ...adapter.getState().pendingUserInput, createdAt: "now" };
    expect(parsePendingUserInputAnswerCommand("1", pending)).toMatchObject({ answers: { q1: ["Yes"] } });
    expect(parsePendingUserInputAnswerCommand("自定义文字", pending)).toMatchObject({ answers: { q1: ["自定义文字"] } });
  });

  test("PermissionRequest fallback supplies updatedInput instead of generic approval", async () => {
    const { adapter, replies, ask } = claude();
    ask("fallback", { ...payload, hook_event_name: "PermissionRequest", tool_input: { questions: [payload.tool_input.questions[0]] } });
    expect(replies).toHaveLength(0);
    expect(await adapter.submitUserInput({ q1: ["No"] }, "fallback")).toBe(true);
    expect(JSON.parse(replies[0].stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { answers: { [payload.tool_input.questions[0].question]: "No" } } },
    });
  });

  test("promotes queued questions and rejects an expired ID", async () => {
    const { adapter, events, ask } = claude();
    ask("first"); ask("second");
    expect(events.filter((event) => event.type === "user_input_required")).toHaveLength(1);
    adapter.handleClosedClaudeHookUserInput("first");
    expect(adapter.getState().pendingUserInput.requestId).toBe("second");
    expect(events.filter((event) => event.type === "user_input_required")).toHaveLength(2);
    expect(await adapter.submitUserInput({ q1: ["Yes"] }, "first")).toBe(false);
    adapter.handleClosedClaudeHookUserInput("second");
    expect(adapter.getState().pendingUserInput).toBeNull();
    expect(adapter.getState().status).toBe("awaiting_input");
    expect(events.at(-1).text).toContain("expired or disconnected");
  });

  test("local completion clears only the matching tool; session end releases remaining hooks", () => {
    const { adapter, replies, ask } = claude();
    ask("first"); ask("second", { ...payload, tool_use_id: "second-tool" });
    ask("post", { ...payload, hook_event_name: "PostToolUse" });
    expect(adapter.getState().pendingUserInput.requestId).toBe("second");
    expect(replies.map((reply) => reply.requestId)).toEqual(["first", "post"]);
    ask("late-post", { ...payload, hook_event_name: "PostToolUse" });
    expect(adapter.getState().pendingUserInput.requestId).toBe("second");
    ask("end", { hook_event_name: "SessionEnd", reason: "exit" });
    expect(adapter.getState().pendingUserInput).toBeNull();
    expect(adapter.pendingHookUserInputs.size).toBe(0);
    expect(replies.map((reply) => reply.requestId)).toContain("second");
  });

  test("malformed and already answered questions pass through; empty completion stays idle", () => {
    const { adapter, replies, ask } = claude();
    ask("invalid", { ...payload, tool_input: { questions: [{}] } });
    ask("answered", { ...payload, tool_input: { questions: [payload.tool_input.questions[0]], answers: { [payload.tool_input.questions[0].question]: "Yes" } } });
    expect(adapter.pendingHookUserInputs.size).toBe(0);
    expect(replies).toHaveLength(2);
    adapter.state.status = "idle";
    ask("post", { ...payload, hook_event_name: "PostToolUse" });
    expect(adapter.getState().status).toBe("idle");
  });

  test("failed writes retain the question for retry", async () => {
    const { adapter, ask } = claude();
    ask("first", { ...payload, tool_input: { questions: [payload.tool_input.questions[0]] } }, { end() { throw new Error("write failed"); } });
    expect(await adapter.submitUserInput({ q1: ["Yes"] }, "first")).toBe(false);
    expect(adapter.getState().pendingUserInput.requestId).toBe("first");
  });

  test("a late answer write cannot restore state after a stop or reset", async () => {
    const { adapter, ask } = claude();
    ask("first", { ...payload, tool_input: { questions: [payload.tool_input.questions[0]] } });
    let finish!: () => void;
    adapter.writeClaudeHookResponse = () => new Promise<void>((resolve) => { finish = resolve; });
    const answering = adapter.submitUserInput({ q1: ["Yes"] }, "first");
    adapter.flushPendingClaudeHookApprovals();
    adapter.state.status = "idle";
    finish();
    expect(await answering).toBe(false);
    expect(adapter.getState().status).toBe("idle");
    expect(adapter.getState().pendingUserInput).toBeNull();
  });

  test("actual hook subprocess receives the answer over TCP", async () => {
    const { adapter } = claude();
    adapter.writeClaudeRuntimeFiles = () => undefined;
    await adapter.startHookServer();
    const child = spawn("node", ["src/bridge/claude-hook.ts"], { env: { ...process.env, CLAUDE_WECHAT_HOOK_PORT: String(adapter.hookPort), CLAUDE_WECHAT_HOOK_TOKEN: adapter.hookToken }, stdio: "pipe" });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    try {
      child.stdin.end(JSON.stringify({ ...payload, tool_input: { questions: [payload.tool_input.questions[0]] } }));
      for (let attempt = 0; !adapter.getState().pendingUserInput && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      const requestId = adapter.getState().pendingUserInput?.requestId;
      expect(requestId).toBeDefined();
      expect(await adapter.submitUserInput({ q1: ["Yes"] }, requestId)).toBe(true);
      expect(await exited).toBe(0);
      expect(JSON.parse(output).hookSpecificOutput.updatedInput.answers).toEqual({ [payload.tool_input.questions[0].question]: "Yes" });
    } finally {
      child.kill();
      await adapter.stopHookServer();
    }
  });

  test("killing an unanswered hook subprocess clears its remote request", async () => {
    const { adapter, events } = claude();
    adapter.writeClaudeRuntimeFiles = () => undefined;
    await adapter.startHookServer();
    const child = spawn("node", ["src/bridge/claude-hook.ts"], { env: { ...process.env, CLAUDE_WECHAT_HOOK_PORT: String(adapter.hookPort), CLAUDE_WECHAT_HOOK_TOKEN: adapter.hookToken }, stdio: "pipe" });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      child.stdin.end(JSON.stringify(payload));
      for (let attempt = 0; !adapter.getState().pendingUserInput && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(adapter.getState().pendingUserInput).not.toBeNull();
      child.kill();
      await exited;
      for (let attempt = 0; adapter.getState().pendingUserInput && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(adapter.getState().pendingUserInput).toBeNull();
      expect(adapter.pendingHookUserInputs.size).toBe(0);
      expect(events.some((event) => event.type === "notice" && event.text.includes("expired or disconnected"))).toBe(true);
    } finally {
      child.kill();
      await adapter.stopHookServer();
    }
  });
});

describe("Claude question companion and routing", () => {
  test("recovers one question per ID, forwards the ID and clears state on disconnect", async () => {
    const adapter = new LocalCompanionProxyAdapter({ kind: "claude", command: "claude", cwd: process.cwd() }) as any;
    const events: any[] = [];
    adapter.setEventSink((event: any) => events.push(event));
    const request = buildClaudeUserInputRequest(payload as unknown as ClaudeHookPayload, "first")!;
    adapter.handlePanelMessage({ type: "state", state: { kind: "claude", command: "claude", cwd: process.cwd(), status: "awaiting_input", pendingUserInput: request, supportsUserInputRequestIds: true } });
    adapter.handlePanelMessage({ type: "event", event: { type: "user_input_required", request, timestamp: "now" } });
    expect(events.filter((event) => event.type === "user_input_required")).toHaveLength(1);
    let sent: any;
    adapter.sendRequest = async (command: any) => { sent = command; return true; };
    expect(await adapter.submitUserInput({ q1: ["Yes"] }, "first")).toBe(true);
    expect(sent.requestId).toBe("first");
    adapter.detachPanelSocket();
    expect(adapter.getState().pendingUserInput).toBeNull();
    expect(await adapter.submitUserInput({ q1: ["Yes"] }, "first")).toBe(false);
  });

  test("standalone answers preserve the parent turn and cannot revive a delayed expired question", async () => {
    const { adapter, ask } = claude();
    const sent: string[] = [];
    const tasks: Promise<void>[] = [];
    const state: any = { authorizedUserId: "owner", pendingUserInput: null };
    const parent = { startedAt: 1, inputPreview: "parent", target: { conversationId: "original" } };
    const stateStore = { getState: () => ({ ...state }), setPendingUserInput: (request: any) => { state.pendingUserInput = request; }, clearPendingUserInput: () => { state.pendingUserInput = null; }, appendLog() {} };
    const options = { adapter: "claude", channelId: "wechat" };
    const channelDriver = { id: "wechat", capabilities: {}, directConversation: (id: string) => ({ channelId: "wechat", conversationId: id, recipientId: id }) };
    const queueWechatMessage = async (_id: string, text: string) => { sent.push(text); return true; };
    const outputBatcher = { flushNow: async () => undefined };
    wireAdapterEvents({ adapter, options, channelDriver, stateStore, outputBatcher, queueWechatMessage, trackWechatForwardTask: (task: Promise<void>) => tasks.push(task), getActiveTask: () => parent,
      syncSharedSessionState() {}, syncLocalClientEndpoint() {}, maybeDrainDeferredInboundMessages: async () => undefined } as any);
    const drain = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.all(tasks); };
    const single = { ...payload, tool_input: { questions: [payload.tool_input.questions[0]] } };
    ask("expired", single); ask("first", single);
    adapter.handleClosedClaudeHookUserInput("expired");
    await drain();
    expect(state.pendingUserInput.requestId).toBe("first");
    expect(sent.filter((text) => text.includes("options:"))).toHaveLength(1);
    ask("second", single);
    const result = await handleInboundMessage({ adapter, options, channelDriver, stateStore, outputBatcher, queueWechatMessage, message: { senderId: "owner", text: "/answer 1" } } as any);
    expect(result).toBeNull();
    await drain();
    expect(state.pendingUserInput.requestId).toBe("second");
    expect(parent.inputPreview).toBe("parent");
  });
});
