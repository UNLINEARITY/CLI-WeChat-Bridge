import { describe, expect, test } from "bun:test";

import {
  WECHAT_SEND_MAX_ATTEMPTS,
  computeWechatSendRetryDelayMs,
  formatUserFacingBridgeFatalError,
  formatUserFacingInboundError,
  formatWechatContextTokenStaleLogEntry,
  formatWechatSendFailureLogEntry,
  formatWechatSendRetryLogEntry,
  isWechatContextUnavailableError,
  isRetryableWechatSendError,
  shouldForwardBridgeEventToWechat,
} from "../../src/bridge/wechat-forwarding.ts";
import { WechatApiResponseError } from "../../src/wechat/wechat-transport.ts";

describe("wechat forwarding helpers", () => {
  test("trims verbose app-server details from bridge fatal errors", () => {
    expect(
      formatUserFacingBridgeFatalError(
        "codex app-server websocket closed unexpectedly. Recent app-server log: codex app-server (WebSockets) listening on: ws://127.0.0.1:12345 readyz: http://127.0.0.1:12345/readyz",
      ),
    ).toBe("Bridge error: codex app-server websocket closed unexpectedly.");
  });

  test("formats send failures with context and recipient", () => {
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

  test("keeps shared retry timing and log formatting stable", () => {
    expect(WECHAT_SEND_MAX_ATTEMPTS).toBe(3);
    expect(computeWechatSendRetryDelayMs(1)).toBe(750);
    expect(computeWechatSendRetryDelayMs(2)).toBe(1_500);
    expect(
      formatWechatSendRetryLogEntry({
        context: "notice",
        recipientId: "owner@im.wechat",
        attempt: 2,
        delayMs: 1_500,
        error: new Error("HTTP 503: upstream unavailable"),
      }),
    ).toBe(
      "wechat_send_retry: context=notice recipient=owner@im.wechat attempt=2 delay_ms=1500 error=Error: HTTP 503: upstream unavailable",
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

  test("recognizes missing and stale WeChat context as recoverable send state", () => {
    expect(
      isWechatContextUnavailableError(
        new Error("No cached context token for owner@im.wechat."),
      ),
    ).toBe(true);
    expect(
      isWechatContextUnavailableError(
        new WechatApiResponseError({ endpoint: "sendmessage", ret: -2 }),
      ),
    ).toBe(true);
    expect(isWechatContextUnavailableError(new Error("HTTP 401: unauthorized"))).toBe(false);
  });

  test("formats OpenCode companion disconnects as a cleaner user-facing message", () => {
    expect(
      formatUserFacingInboundError({
        adapter: "opencode",
        cwd: "C:\\Users\\unlin",
        errorText:
          'opencode companion is not connected. Run "wechat-opencode" in a second terminal for this directory.',
      }),
    ).toBe(
      'OpenCode is not connected for workspace:\nC:\\Users\\unlin\nRun "wechat-opencode" in that directory to recreate or reconnect the visible terminal.',
    );
  });

  test("keeps generic inbound bridge errors for other adapters", () => {
    expect(
      formatUserFacingInboundError({
        adapter: "codex",
        errorText: "codex app-server websocket closed unexpectedly.",
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

  test("suppresses Pi terminal streams while forwarding structured notices", () => {
    expect(shouldForwardBridgeEventToWechat("pi", "stdout")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("pi", "stderr")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("pi", "notice")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("pi", "mirrored_user_input")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("pi", "final_reply")).toBe(true);
  });

  test("keeps non-OpenCode adapters forwarding bridge events", () => {
    expect(shouldForwardBridgeEventToWechat("codex", "stdout")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("claude", "notice")).toBe(true);
  });
});
