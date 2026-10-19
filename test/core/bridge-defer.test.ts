// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "../../src/i18n/index.ts";

import {
  canDrainDeferredCodexInboundQueue,
  formatDeferredCodexInboundQueueMessage,
  isRetryableDeferredCodexDrainError,
  shouldDeferCodexInboundMessage,
} from "../../src/core/bridge-defer.ts";

beforeEach(() => setLocale("en"));

describe("deferred Codex inbound queue", () => {
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
