import { describe, expect, test } from "bun:test";

import {
  RESUME_SESSION_SNAPSHOT_TTL_MS,
  ResumeSessionCoordinator,
  isWechatResumeEnabled,
  shouldForwardSessionSwitchEvent,
} from "../../src/bridge/bridge-session-resume.ts";
import type {
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
} from "../../src/bridge/bridge-types.ts";

function buildCandidate(sessionId: string, title = sessionId): BridgeResumeSessionCandidate {
  return {
    sessionId,
    title,
    lastUpdatedAt: "2026-08-24T08:00:00.000Z",
  };
}

function buildRuntime(options: {
  candidates?: BridgeResumeSessionCandidate[];
  currentSessionId?: string;
  listError?: Error;
}) {
  const resumedSessionIds: string[] = [];
  const state: BridgeAdapterState = {
    kind: "opencode",
    status: "idle",
    cwd: process.cwd(),
    command: "opencode",
    sharedSessionId: options.currentSessionId,
  };
  return {
    resumedSessionIds,
    runtime: {
      getState: () => state,
      listResumeSessions: async (_limit?: number) => {
        if (options.listError) {
          throw options.listError;
        }
        return options.candidates ?? [];
      },
      resumeSession: async (sessionId: string) => {
        resumedSessionIds.push(sessionId);
        state.sharedSessionId = sessionId;
      },
    },
  };
}

describe("ResumeSessionCoordinator", () => {
  test("enables WeChat resume only for the first-stage adapters", () => {
    expect(isWechatResumeEnabled("opencode")).toBe(true);
    expect(isWechatResumeEnabled("pi")).toBe(true);
    expect(isWechatResumeEnabled("claude")).toBe(true);
    expect(isWechatResumeEnabled("codex")).toBe(false);
  });

  test("suppresses the adapter event for a WeChat-acknowledged switch", () => {
    expect(shouldForwardSessionSwitchEvent("wechat_resume")).toBe(false);
    expect(shouldForwardSessionSwitchEvent("local_follow")).toBe(true);
  });

  test("lists recent sessions and resolves a displayed number", async () => {
    const { runtime, resumedSessionIds } = buildRuntime({
      candidates: [
        buildCandidate("ses_current", "Current session"),
        buildCandidate("ses_target", "Target session"),
      ],
      currentSessionId: "ses_current",
    });
    const coordinator = new ResumeSessionCoordinator({
      adapter: "opencode",
      runtime,
    });

    const listed = await coordinator.execute();
    const resumed = await coordinator.execute("2");

    expect(listed).toEqual({
      kind: "list",
      message: expect.stringContaining("2. Target session"),
    });
    expect(listed.message).toContain("[current]");
    expect(resumed).toEqual({
      kind: "resumed",
      sessionId: "ses_target",
      message: "OpenCode session switched to ses_target from WeChat.",
    });
    expect(resumedSessionIds).toEqual(["ses_target"]);
  });

  test("rejects numeric selection after the displayed list expires", async () => {
    let nowMs = 1_000;
    const { runtime } = buildRuntime({
      candidates: [buildCandidate("pi-session-1")],
    });
    const coordinator = new ResumeSessionCoordinator({
      adapter: "pi",
      runtime,
      now: () => nowMs,
    });

    await coordinator.execute();
    nowMs += RESUME_SESSION_SNAPSHOT_TTL_MS + 1;

    await expect(coordinator.execute("1")).rejects.toThrow(
      "The recent session list has expired",
    );
  });

  test("resolves a unique ID prefix and rejects an ambiguous prefix", async () => {
    const { runtime, resumedSessionIds } = buildRuntime({
      candidates: [
        buildCandidate("ses_alpha_123456"),
        buildCandidate("ses_beta_123456"),
      ],
    });
    const coordinator = new ResumeSessionCoordinator({
      adapter: "opencode",
      runtime,
    });

    await expect(coordinator.execute("ses_")).rejects.toThrow("is ambiguous");
    await coordinator.execute("ses_beta");

    expect(resumedSessionIds).toEqual(["ses_beta_123456"]);
  });

  test("does not invoke the adapter when the selected session is already active", async () => {
    const { runtime, resumedSessionIds } = buildRuntime({
      candidates: [buildCandidate("pi-session-current")],
      currentSessionId: "pi-session-current",
    });
    const coordinator = new ResumeSessionCoordinator({
      adapter: "pi",
      runtime,
    });

    await coordinator.execute();
    const result = await coordinator.execute("1");

    expect(result).toEqual({
      kind: "already_active",
      sessionId: "pi-session-current",
      message: "Pi session pi-session-c is already active.",
    });
    expect(resumedSessionIds).toEqual([]);
  });

  test("keeps list failures distinct from an empty session list", async () => {
    const { runtime } = buildRuntime({
      listError: new Error("SDK authentication failed"),
    });
    const coordinator = new ResumeSessionCoordinator({
      adapter: "opencode",
      runtime,
    });

    await expect(coordinator.execute()).rejects.toThrow(
      "Failed to list OpenCode sessions: SDK authentication failed",
    );
  });
});
