import { describe, expect, test } from "bun:test";

import {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  isRetryableDeferredCodexDrainError,
  parseCliArgs,
  shouldDeferCodexInboundMessage,
  shouldWatchParentProcess,
} from "../../src/bridge/wechat-bridge.ts";

describe("wechat-bridge cli helpers", () => {
  test("parseCliArgs keeps persistent lifecycle by default", () => {
    const options = parseCliArgs(["--adapter", "codex"]);

    expect(options.lifecycle).toBe("persistent");
    expect(options.sessionStartMode).toBe("restore");
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

  test("parseCliArgs accepts internal new session startup mode", () => {
    const options = parseCliArgs([
      "--adapter",
      "claude",
      "--session-start-mode",
      "new",
    ]);

    expect(options.sessionStartMode).toBe("new");
  });

  test("parseCliArgs selects the WeCom channel without changing adapter arguments", () => {
    const options = parseCliArgs([
      "--adapter",
      "codex",
      "--channel",
      "wecom",
    ]);

    expect(options.channelId).toBe("wecom");
    expect(options.adapter).toBe("codex");
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
        hasPendingUserInput: false,
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
        hasPendingUserInput: false,
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
        hasPendingUserInput: false,
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
        hasPendingUserInput: false,
        hasPendingApproval: false,
        hasActiveTask: true,
      }),
    ).toBe(false);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "awaiting_input",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingUserInput: true,
        hasPendingApproval: false,
        hasActiveTask: false,
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
        "A Codex approval request is pending. Reply with /confirm or /deny.",
      ),
    ).toBe(true);
    expect(isRetryableDeferredCodexDrainError("codex panel is not running.")).toBe(false);
  });
});
