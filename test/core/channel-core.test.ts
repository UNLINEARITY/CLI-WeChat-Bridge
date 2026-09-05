import { describe, expect, test } from "bun:test";

import { parseBridgeControlCommand } from "../../src/core/bridge-control.ts";
import { routeBridgeMessage } from "../../src/core/bridge-message-router.ts";
import { WechatChannelPort } from "../../src/channels/wechat/wechat-channel-port.ts";
import type {
  BridgeChannelPort,
  ChannelOutput,
} from "../../src/core/channel-types.ts";

class FakeChannel implements BridgeChannelPort {
  readonly channelId = "fake";
  readonly outputs: ChannelOutput[] = [];

  async send(output: ChannelOutput): Promise<boolean> {
    this.outputs.push(output);
    return true;
  }
}

const target = {
  channelId: "fake",
  conversationId: "conversation-1",
  recipientId: "user-1",
  opaqueRef: "opaque-context-token",
};

describe("channel-neutral bridge core", () => {
  test("keeps channel state opaque and sends output through a fake channel", async () => {
    const channel = new FakeChannel();
    await channel.send({ target, kind: "final_reply", text: "done" });

    expect(channel.outputs[0]?.target.opaqueRef).toBe("opaque-context-token");
    expect(channel.outputs[0]?.text).toBe("done");
  });

  test("keeps WeChat final-reply formatting behind the channel port", async () => {
    const sent: string[] = [];
    const port = new WechatChannelPort({
      sendText: async (_recipientId, text) => {
        sent.push(text);
        return true;
      },
      sendImage: async () => undefined,
      sendFile: async () => undefined,
      sendVoice: async () => undefined,
      sendVideo: async () => undefined,
    });

    await port.send({
      target: {
        channelId: "wechat",
        conversationId: "conversation-1",
        recipientId: "user-1",
        opaqueRef: "opaque-context-token",
      },
      kind: "final_reply",
      text: "done",
      adapter: "codex",
    });

    expect(sent).toEqual(["done"]);
  });

  test("parses canonical control commands without a channel name", () => {
    expect(parseBridgeControlCommand("/resume 2")).toEqual({
      type: "resume",
      target: "2",
    });
    expect(parseBridgeControlCommand("/new-session")).toEqual({
      type: "new_session",
    });
    expect(parseBridgeControlCommand("ordinary text")).toBeNull();
  });

  test("parses Codex model and plan commands", () => {
    expect(parseBridgeControlCommand("/model")).toEqual({ type: "model", target: undefined });
    expect(parseBridgeControlCommand("/model 2")).toEqual({ type: "model", target: "2" });
    expect(parseBridgeControlCommand("/plan")).toEqual({ type: "plan", enabled: true });
    expect(parseBridgeControlCommand("/plan off")).toEqual({ type: "plan", enabled: false });
  });

  test("orders command, pending-state, defer, busy, and dispatch gates", async () => {
    const calls: string[] = [];
    const result = await routeBridgeMessage({
      message: {
        id: "message-1",
        conversation: target,
        senderId: "user-1",
        text: "hello",
        attachments: [],
        createdAt: new Date(0).toISOString(),
      },
      authorized: true,
      command: null,
      adapterState: { status: "idle" },
      hasPendingApproval: false,
      hasPendingUserInput: false,
      onUnauthorized: async () => calls.push("unauthorized"),
      handleCommand: async () => false,
      remindPendingApproval: async () => calls.push("approval"),
      remindPendingUserInput: async () => calls.push("input"),
      remindBusy: async () => calls.push("busy"),
      defer: async () => calls.push("defer"),
      dispatch: async () => {
        calls.push("dispatch");
        return "task";
      },
    });

    expect(result).toEqual({ kind: "dispatched", result: "task" });
    expect(calls).toEqual(["dispatch"]);
  });
});
