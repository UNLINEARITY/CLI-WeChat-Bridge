import net from "node:net";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildCompanionHealthPatch,
  buildCompanionReconnectTimeoutMessage,
  formatCompanionNotConnectedMessage,
  formatLocalCompanionStartupMessage,
  getCompanionDisconnectDisposition,
  isExpectedLocalCompanionClose,
  LocalCompanionProxyAdapter,
  shouldStopBridgeAfterCompanionDisconnect,
} from "../../src/bridge/bridge-adapters.core.ts";
import {
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
  sendLocalCompanionMessage,
} from "../../src/companion/local-companion-link.ts";

describe("local companion proxy lifecycle", () => {
  test("persistent bridges stay alive after companion disconnect", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect("persistent")).toBe(false);
  });

  test("companion-bound bridges stop after companion disconnect", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect("companion_bound")).toBe(true);
  });

  test("undefined lifecycle keeps the historical persistent behavior", () => {
    expect(shouldStopBridgeAfterCompanionDisconnect(undefined)).toBe(false);
  });

  test("companion-bound bridges stop immediately after an expected close", () => {
    expect(
      getCompanionDisconnectDisposition({
        kind: "codex",
        lifecycle: "companion_bound",
        expectedClose: true,
        reconnectGraceMs: 15_000,
      }),
    ).toEqual({
      action: "shutdown",
      shutdownReason: "companion_closed",
      message:
        "codex companion closed. Stopping transient bridge bound to wechat-codex.",
    });
  });

  test("companion-bound bridges wait through a reconnect window after unexpected disconnects", () => {
    expect(
      getCompanionDisconnectDisposition({
        kind: "codex",
        lifecycle: "companion_bound",
        expectedClose: false,
        reconnectGraceMs: 15_000,
      }),
    ).toEqual({
      action: "wait_for_reconnect",
      message:
        "codex companion disconnected unexpectedly. Waiting up to 15s for wechat-codex to reconnect before stopping this transient bridge.",
    });
  });

  test("persistent bridges fall back to manual reconnect after unexpected disconnects", () => {
    expect(
      getCompanionDisconnectDisposition({
        kind: "claude",
        lifecycle: "persistent",
        expectedClose: false,
        reconnectGraceMs: 15_000,
      }),
    ).toEqual({
      action: "await_manual_reconnect",
      message:
        'claude companion disconnected unexpectedly. Run "wechat-claude" again in a second terminal for this directory to reconnect.',
    });
  });

  test("daemon-managed companions do not ask users to open a second terminal", () => {
    const startupMessage = formatLocalCompanionStartupMessage({
      kind: "opencode",
      launchMode: "daemon_auto",
    });
    const missingMessage = formatCompanionNotConnectedMessage({
      kind: "opencode",
      launchMode: "daemon_auto",
    });
    const disconnect = getCompanionDisconnectDisposition({
      kind: "opencode",
      lifecycle: "persistent",
      expectedClose: false,
      reconnectGraceMs: 15_000,
      launchMode: "daemon_auto",
    });

    expect(startupMessage).toContain("daemon-managed opencode");
    expect(startupMessage).not.toContain("second terminal");
    expect(missingMessage).toContain("Send /opencode in WeChat");
    expect(missingMessage).not.toContain("second terminal");
    expect(disconnect.message).toContain("Send /opencode in WeChat");
    expect(disconnect.message).not.toContain("second terminal");
  });

  test("companion state updates preserve visible companion occupancy", async () => {
    const cwd = path.resolve("tmp/daemon-visible-companion");
    clearLocalCompanionEndpoint(cwd, undefined, { adapter: "claude" });
    const adapter = new LocalCompanionProxyAdapter({
      kind: "claude",
      command: "claude",
      cwd,
      lifecycle: "persistent",
      companionLaunchMode: "daemon_auto",
    });

    await adapter.start();
    const endpoint = readLocalCompanionEndpoint(cwd, { adapter: "claude" });
    expect(endpoint).toBeTruthy();

    const socket = net.connect({
      host: "127.0.0.1",
      port: endpoint?.port ?? 0,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });

      sendLocalCompanionMessage(socket, {
        type: "hello",
        token: endpoint?.token ?? "",
        companionPid: 12_345,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      sendLocalCompanionMessage(socket, {
        type: "state",
        state: {
          kind: "claude",
          status: "idle",
          cwd,
          command: "claude",
          pid: 54_321,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const updated = readLocalCompanionEndpoint(cwd, { adapter: "claude" });
      expect(updated?.companionPid).toBe(12_345);
      expect(updated?.companionWorkerPid).toBe(54_321);
      expect(updated?.companionStatus).toBe("idle");
    } finally {
      socket.destroy();
      await adapter.dispose();
      clearLocalCompanionEndpoint(cwd, undefined, { adapter: "claude" });
    }
  });

  test("expected close detection only treats explicit closing reasons as expected", () => {
    expect(isExpectedLocalCompanionClose("worker_exit")).toBe(true);
    expect(isExpectedLocalCompanionClose("bridge_dispose")).toBe(true);
    expect(isExpectedLocalCompanionClose(null)).toBe(false);
    expect(isExpectedLocalCompanionClose(undefined)).toBe(false);
  });

  test("formats reconnect timeout messages with the grace window", () => {
    expect(
      buildCompanionReconnectTimeoutMessage({
        kind: "codex",
        reconnectGraceMs: 15_000,
      }),
    ).toBe(
      "codex companion did not reconnect within 15s. Stopping transient bridge bound to wechat-codex.",
    );
  });

  test("buildCompanionHealthPatch persists stopped worker state for auto-heal decisions", () => {
    expect(
      buildCompanionHealthPatch(
        {
          kind: "codex",
          status: "stopped",
          pid: undefined,
          cwd: "D:/work/project",
          command: "codex",
        },
        "2026-03-28T00:08:00.000Z",
      ),
    ).toEqual({
      companionStatus: "stopped",
      companionLastStateAt: "2026-03-28T00:08:00.000Z",
      companionWorkerPid: undefined,
    });
  });
});
