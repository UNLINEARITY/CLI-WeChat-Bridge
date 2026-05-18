import { describe, expect, test } from "bun:test";

import {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  formatWechatContextTokenStaleLogEntry,
  formatUserFacingInboundError,
  formatWechatSendFailureLogEntry,
  isRetryableDeferredCodexDrainError,
  isRetryableWechatSendError,
  formatUserFacingBridgeFatalError,
  parseCliArgs,
  shouldDeferCodexInboundMessage,
  shouldForwardBridgeEventToWechat,
  shouldWatchParentProcess,
} from "../../src/bridge/wechat-bridge.ts";
import { WechatApiResponseError } from "../../src/wechat/wechat-transport.ts";

describe("wechat-bridge cli helpers", () => {
  test("parseCliArgs keeps persistent lifecycle by default", () => {
    const options = parseCliArgs(["--adapter", "codex"]);

    expect(options.lifecycle).toBe("persistent");
  });

  test("parseCliArgs accepts --lifecycle companion_bound", () => {
    const options = parseCliArgs([
      "--adapter",
      "codex",
      "--lifecycle",
      "companion_bound",
    ]);

    expect(options.lifecycle).toBe("companion_bound");
  });

  test("shouldWatchParentProcess watches attached terminal bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: true,
        lifecycle: "persistent",
      }),
    ).toBe(true);
  });

  test("shouldWatchParentProcess watches detached companion-bound bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: false,
        lifecycle: "companion_bound",
      }),
    ).toBe(true);
  });

  test("shouldWatchParentProcess ignores detached persistent bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: false,
        lifecycle: "persistent",
      }),
    ).toBe(false);
  });

  test("formatUserFacingBridgeFatalError trims verbose app-server log details", () => {
    expect(
      formatUserFacingBridgeFatalError(
        "codex app-server websocket closed unexpectedly. Recent app-server log: codex app-server (WebSockets) listening on: ws://127.0.0.1:12345 readyz: http://127.0.0.1:12345/readyz",
      ),
    ).toBe("Bridge error: codex app-server websocket closed unexpectedly.");
  });

  test("formatWechatSendFailureLogEntry includes the failed context and recipient", () => {
    expect(
      formatWechatSendFailureLogEntry({
        context: "thread_switched",
        recipientId: "owner@im.wechat",
        error: new Error("HTTP 503: upstream unavailable"),
      }),
    ).toBe(
      "wechat_send_failed: context=thread_switched recipient=owner@im.wechat error=Error: HTTP 503: upstream unavailable",
    );
  });

  test("formats stale WeChat context token failures separately", () => {
    expect(
      formatWechatContextTokenStaleLogEntry({
        context: "final_reply",
        recipientId: "owner@im.wechat",
        error: new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: -2,
        }),
      }),
    ).toBe(
      "wechat_context_token_stale: context=final_reply recipient=owner@im.wechat action=wechat_message_required error=WechatApiResponseError: sendmessage failed: ret=-2 errcode=undefined errmsg=",
    );
  });

  test("does not retry stale WeChat context token send failures", () => {
    expect(
      isRetryableWechatSendError(
        new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: -2,
        }),
      ),
    ).toBe(false);

    expect(isRetryableWechatSendError(new Error("HTTP 503: upstream unavailable"))).toBe(true);
    expect(
      isRetryableWechatSendError(
        new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: 1,
          errcode: 45009,
          errmsg: "rate limited",
        }),
      ),
    ).toBe(true);
  });

  test("formats opencode companion disconnects as a cleaner user-facing message", () => {
    expect(
      formatUserFacingInboundError({
        adapter: "opencode",
        cwd: "C:\\Users\\unlin",
        errorText:
          'opencode companion is not connected. Run "wechat-opencode" in a second terminal for this directory.',
        isUserFacingShellRejection: false,
      }),
    ).toBe(
      'OpenCode companion is not connected for bridge workspace:\nC:\\Users\\unlin\nRun "wechat-opencode" in that directory to reconnect the current local terminal, or run "wechat-bridge-opencode" and then "wechat-opencode" in your target project to replace this bridge.',
    );
  });

  test("keeps generic inbound bridge errors for other adapters", () => {
    expect(
      formatUserFacingInboundError({
        adapter: "codex",
        errorText: "codex app-server websocket closed unexpectedly.",
        isUserFacingShellRejection: false,
      }),
    ).toBe("Bridge error: codex app-server websocket closed unexpectedly.");
  });

  test("suppresses noisy OpenCode bridge events from WeChat replies", () => {
    expect(shouldForwardBridgeEventToWechat("opencode", "stdout")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("opencode", "stderr")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("opencode", "notice")).toBe(false);
    expect(
      shouldForwardBridgeEventToWechat("opencode", "notice", {
        text: "OpenCode is still working on:\nReview the bridge",
      }),
    ).toBe(false);
    expect(
      shouldForwardBridgeEventToWechat("opencode", "notice", {
        text: "OpenCode local draft:\nReview the bridge",
      }),
    ).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "mirrored_user_input")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "session_switched")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "thread_switched")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("opencode", "final_reply")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "approval_required")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "fatal_error")).toBe(true);
  });

  test("keeps non-OpenCode adapters forwarding bridge events", () => {
    expect(shouldForwardBridgeEventToWechat("codex", "stdout")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("claude", "notice")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("shell", "stderr")).toBe(true);
  });

  test("defers inbound WeChat text when Codex is busy with a local turn", () => {
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "codex",
        status: "busy",
        activeTurnOrigin: "local",
        hasPendingConfirmation: false,
        hasSystemCommand: false,
      }),
    ).toBe(true);
  });

  test("does not defer Codex inbound text for WeChat-owned busy turns or commands", () => {
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "codex",
        status: "busy",
        activeTurnOrigin: "wechat",
        hasPendingConfirmation: false,
        hasSystemCommand: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "codex",
        status: "busy",
        activeTurnOrigin: "local",
        hasPendingConfirmation: false,
        hasSystemCommand: true,
      }),
    ).toBe(false);
  });

  test("does not defer non-Codex adapters", () => {
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "opencode",
        status: "busy",
        activeTurnOrigin: "local",
        hasPendingConfirmation: false,
        hasSystemCommand: false,
      }),
    ).toBe(false);
  });

  test("only drains the deferred Codex queue when the bridge is truly idle", () => {
    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "idle",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(true);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "busy",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(false);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "idle",
        activeTurnId: "turn-123",
        hasPendingConfirmation: false,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(false);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "idle",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingApproval: false,
        hasActiveTask: true,
      }),
    ).toBe(false);
  });

  test("formats the deferred Codex queue confirmation for WeChat", () => {
    expect(formatDeferredCodexInboundQueueMessage(2)).toBe(
      "Queued for delivery after the current local Codex turn finishes. Queue position: 2.",
    );
  });

  test("retries deferred Codex drain failures only for transient local-busy conditions", () => {
    expect(
      isRetryableDeferredCodexDrainError(
        "The local Codex panel is still working. Wait for the current reply or use /stop.",
      ),
    ).toBe(true);
    expect(
      isRetryableDeferredCodexDrainError(
        "A Codex approval request is pending. Reply with /confirm <code> or /deny.",
      ),
    ).toBe(true);
    expect(isRetryableDeferredCodexDrainError("codex panel is not running.")).toBe(false);
  });
});
