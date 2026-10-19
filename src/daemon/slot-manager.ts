// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { resolveDefaultAdapterCommand } from "../bridge/bridge-adapters.ts";
import { t } from "../i18n/index.ts";
import { getSharedSessionIdFromAdapterState } from "../bridge/bridge-adapters.shared.ts";
import { BridgeController } from "../bridge/bridge-controller.ts";
import type { BridgeAdapter, BridgeSessionStartMode, BridgeEvent } from "../bridge/bridge-types.ts";
import { formatDuration, OutputBatcher, truncatePreview } from "../bridge/bridge-utils.ts";
import { ResumeSessionCoordinator } from "../bridge/bridge-session-resume.ts";
import type { WechatSendContext } from "../channels/wechat/wechat-forwarding.ts";
import { BRIDGE_LOG_FILE } from "../wechat/channel-config.ts";
import { createRuntimeHost } from "../runtime/create-runtime-host.ts";
import { TurnCoordinator } from "../core/turn-coordinator.ts";
import { invalidateModelSnapshot } from "../bridge/adapter-control.ts";
import type { BridgeChannelId, ChannelConversationRef } from "../core/channel-types.ts";
import {
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";
import { log } from "./daemon-shared.ts";
import { defaultDaemonSessionStartMode, resolveDaemonSessionStartMode } from "./daemon-commands.ts";
import {
  VISIBLE_CLIENT_CONNECT_TIMEOUT_MS,
  type VisibleClientLaunch,
  formatLaunchPreview,
  openVisibleClient,
  shouldRestartDeadCodexVisibleRuntime,
  cleanupVisibleClientLauncher,
  waitForVisibleClientConnection,
  waitForCodexVisibleThread,
} from "./visible-client-launcher.ts";
import {
  type ActiveTask,
  type DaemonSlot,
  prefixDaemonAdapterMessage,
  type EnsureSlotOptions,
  type EnsureSlotResult,
} from "./daemon-slot.ts";

export type SlotManagerHost = {
  cwd: string;
  profile?: string;
  channelId: BridgeChannelId;
  operatorId: string;
  visibleClientConnectTimeoutMs?: number;
  createRuntime: (options: Parameters<typeof createRuntimeHost>[0]) => BridgeAdapter;
  isVisibleClientAlive: (cwd: string, adapter: DaemonAdapterKind) => boolean;
  openVisibleClient: (options: Parameters<typeof openVisibleClient>[0]) => VisibleClientLaunch;
  queueMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  resolveSlotOutputTarget: (slot: DaemonSlot) => ChannelConversationRef;
  onSlotEvent: (slot: DaemonSlot, event: BridgeEvent) => void;
  daemonLog: (message: string) => void;
};

/** Owns the daemon's adapter slots, the active adapter, and per-slot serialization. */
export class SlotManager {
  readonly slots = new Map<DaemonAdapterKind, DaemonSlot>();
  // Per-adapter serialization chains for ensureSlot (see ensureSlot comment).
  private readonly slotEnsureChains = new Map<DaemonAdapterKind, Promise<unknown>>();
  private readonly slotInputChains = new Map<DaemonAdapterKind, Promise<unknown>>();
  activeAdapter: DaemonAdapterKind | null = null;
  private activeAdapterVersion = 0;
  takenOverAdapter?: DaemonAdapterKind;
  private readonly host: SlotManagerHost;

  constructor(host: SlotManagerHost) {
    this.host = host;
  }

  /**
   * Remove a slot whose runtime reported a fatal (terminal) error. The dead
   * runtime would otherwise stay in the slot map forever: every later message
   * would fail against it ("adapter is not running") with no path back to a
   * working adapter short of a manual /reset or daemon restart. After removal,
   * the next switch directive (/codex etc.) rebuilds the adapter from scratch.
   */
  disposeDeadSlot(slot: DaemonSlot): void {
    if (this.slots.get(slot.adapter) !== slot) {
      return; // Already replaced by a newer ensureSlot run.
    }
    this.slots.delete(slot.adapter);
    if (this.activeAdapter === slot.adapter) {
      this.activeAdapter = null;
    }
    this.host.daemonLog(`dead_slot_disposed: adapter=${slot.adapter}`);
    void (async () => {
      try {
        await slot.runtime.dispose();
      } catch {
        // Best effort: the runtime already reported a fatal error.
      }
      slot.controller.clearLocalClientEndpoint();
    })();
  }

  restoreActiveAdapterAfterRejectedInput(
    adapter: DaemonAdapterKind,
    activationVersion: number,
    previousActiveAdapter: DaemonAdapterKind | null,
  ): void {
    if (this.activeAdapter === adapter && this.activeAdapterVersion === activationVersion) {
      this.activeAdapter = previousActiveAdapter;
      this.activeAdapterVersion += 1;
    }
  }

  serializeSlotInput<T>(slot: DaemonSlot, task: () => Promise<T>): Promise<T> {
    const tail = this.slotInputChains.get(slot.adapter) ?? Promise.resolve();
    const run = tail.then(task, task);
    this.slotInputChains.set(slot.adapter, run.then(() => undefined, () => undefined));
    return run;
  }

  async ensureSlot(
    adapter: DaemonAdapterKind,
    options: EnsureSlotOptions = {},
  ): Promise<EnsureSlotResult> {
    // Serialize per-adapter ensureSlot runs. The IPC handler, the WeChat poll
    // loop, and startup can all call this concurrently; without serialization
    // two callers would both observe an empty slot map, create two runtimes,
    // and the second slots.set would orphan the first (duplicate PTY child,
    // double visible client, endpoint files overwriting each other).
    const tail = this.slotEnsureChains.get(adapter) ?? Promise.resolve();
    const run = tail.then(
      () => this.runEnsureSlot(adapter, options),
      // A rejected predecessor must not block this run — start fresh either way.
      () => this.runEnsureSlot(adapter, options),
    );
    this.slotEnsureChains.set(
      adapter,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async runEnsureSlot(
    adapter: DaemonAdapterKind,
    options: EnsureSlotOptions = {},
  ): Promise<EnsureSlotResult> {
    const previousActiveAdapter = this.activeAdapter ?? undefined;
    let slot = this.slots.get(adapter);
    let created = false;
    if (!slot) {
      const createSessionStartMode =
        options.sessionStartMode ??
        (adapter === this.takenOverAdapter ? "restore" : defaultDaemonSessionStartMode(adapter));
      if (adapter === this.takenOverAdapter) {
        this.takenOverAdapter = undefined;
      }
      slot = await this.createSlot(adapter, {
        profile: options.profile ?? this.host.profile,
        sessionStartMode: createSessionStartMode,
      });
      this.slots.set(adapter, slot);
      created = true;
    }

    let openedVisible = false;
    const visibleEndpointBeforeProbe = readLocalCompanionEndpoint(this.host.cwd, {
      adapter,
    });
    const hadVisibleClient = Boolean(
      visibleEndpointBeforeProbe?.companionPid ||
        visibleEndpointBeforeProbe?.companionConnectedAt ||
        visibleEndpointBeforeProbe?.sharedThreadId ||
        visibleEndpointBeforeProbe?.sharedSessionId,
    );
    let visibleConnected = this.host.isVisibleClientAlive(this.host.cwd, adapter);
    if (
      shouldRestartDeadCodexVisibleRuntime({
        adapter,
        slotCreated: created,
        hadVisibleClient,
        visibleConnected,
      })
    ) {
      await this.startFreshSlotSession(slot);
      this.host.daemonLog(
        `dead_visible_codex_runtime_restarted: cwd=${this.host.cwd}`,
      );
    }
    const sharedSessionBeforeVisible = getSharedSessionIdFromAdapterState(
      slot.runtime.getState(),
    );
    const sessionStartMode = resolveDaemonSessionStartMode({
      adapter,
      explicitSessionStartMode: options.sessionStartMode,
      slotCreated: created,
      visibleConnected,
      sharedSessionId: getSharedSessionIdFromAdapterState(slot.runtime.getState()),
      reuseExistingVisible: options.reuseExistingVisible !== false,
    });
    if (
      !created &&
      (options.reuseExistingVisible === false ||
        options.sessionStartMode === "new") &&
      sessionStartMode === "new" &&
      (adapter === "claude" || adapter === "opencode" || adapter === "pi") &&
      visibleConnected
    ) {
      await this.startFreshSlotSession(slot);
      this.host.daemonLog(`fresh_session_started: adapter=${adapter} source=start_command`);
    }

    if (options.openVisible !== false && !visibleConnected) {
      const visibleClientTimeoutMs =
        this.host.visibleClientConnectTimeoutMs ?? VISIBLE_CLIENT_CONNECT_TIMEOUT_MS;
      slot.controller.syncLocalClientEndpoint();
      const launch = this.host.openVisibleClient({
        adapter,
        cwd: this.host.cwd,
        // A freshly prepared blank thread is semantically a new session, but
        // the visible client must resume its id from the endpoint instead of
        // creating a second thread of its own.
        sessionStartMode,
        cliArgs: options.cliArgs,
        channelId: this.host.channelId,
        onError: (error) => {
          this.host.daemonLog(
            `visible_client_open_error: adapter=${adapter} error=${truncatePreview(error.message, 400)}`,
          );
        },
      });
      openedVisible = true;
      this.host.daemonLog(
        `visible_client_open_attempt: adapter=${adapter} cwd=${this.host.cwd} pid=${launch.pid ?? "unknown"} command=${truncatePreview(formatLaunchPreview(launch), 400)}`,
      );
      visibleConnected = await waitForVisibleClientConnection({
        cwd: this.host.cwd,
        adapter,
        timeoutMs: this.host.visibleClientConnectTimeoutMs,
      }, {
        isAlive: (cwd, adapter) => this.host.isVisibleClientAlive(cwd, adapter),
      });
      if (visibleConnected) {
        this.host.daemonLog(`visible_client_connected: adapter=${adapter} cwd=${this.host.cwd}`);
      } else {
        log(
          `${adapter} visible CLI did not connect within ${formatDuration(visibleClientTimeoutMs)}. Check ${BRIDGE_LOG_FILE}.`,
        );
        const cleanedLauncher = cleanupVisibleClientLauncher(launch);
        this.host.daemonLog(
          `visible_client_connect_timeout: adapter=${adapter} cwd=${this.host.cwd} timeout_ms=${visibleClientTimeoutMs} cleaned_launcher=${cleanedLauncher}`,
        );
      }
    }

    let visibleReady = visibleConnected;
    if (adapter === "codex" && visibleConnected && !sharedSessionBeforeVisible) {
      const visibleThreadId = await waitForCodexVisibleThread({
        getThreadId: () => {
          const state = slot.runtime.getState();
          if (state.lastThreadSwitchSource !== "local") {
            return undefined;
          }
          return state.sharedThreadId ?? state.sharedSessionId;
        },
      });
      visibleReady = Boolean(visibleThreadId);
      if (visibleThreadId) {
        this.host.daemonLog(
          `visible_codex_thread_ready: thread=${visibleThreadId} cwd=${this.host.cwd}`,
        );
      } else {
        this.host.daemonLog(
          `visible_codex_thread_timeout: cwd=${this.host.cwd} timeout_ms=${VISIBLE_CLIENT_CONNECT_TIMEOUT_MS}`,
        );
      }
    }

    const activated = options.openVisible === false || (visibleConnected && visibleReady);
    if (activated) {
      const previousSlot = this.getActiveSlot();
      if (previousSlot && this.activeAdapter !== adapter) invalidateModelSnapshot(previousSlot.runtime);
      this.activeAdapter = adapter;
      this.activeAdapterVersion += 1;
    }

    this.host.daemonLog(
      `switch_adapter: adapter=${adapter} created=${created} opened_visible=${openedVisible} visible_connected=${visibleConnected} visible_ready=${visibleReady} activated=${activated} previous_active=${previousActiveAdapter ?? "(none)"} session_start_mode=${sessionStartMode}`,
    );
    return {
      activeAdapter: adapter,
      created,
      openedVisible,
      visibleConnected,
      visibleReady,
      activated,
      activationVersion: this.activeAdapterVersion,
      previousActiveAdapter,
    };
  }

  private async createSlot(
    adapter: DaemonAdapterKind,
    options: { profile?: string; sessionStartMode?: BridgeSessionStartMode },
  ): Promise<DaemonSlot> {
    clearLocalCompanionEndpoint(this.host.cwd, undefined, { adapter });
    const runtime = this.host.createRuntime({
      kind: adapter,
      command: resolveDefaultAdapterCommand(adapter),
      cwd: this.host.cwd,
      profile: options.profile,
      lifecycle: "persistent",
      sessionStartMode: options.sessionStartMode,
      companionLaunchMode: "daemon_auto",
    });
    const controller = new BridgeController(runtime, this.host.cwd);
    const slot: DaemonSlot = {
      adapter,
      runtime,
      controller,
      outputBatcher: new OutputBatcher(async (text) => {
        await this.host.queueMessage(
          this.host.operatorId,
          prefixDaemonAdapterMessage(adapter, text),
          "message",
          this.host.resolveSlotOutputTarget(slot),
        );
      }),
      pendingConfirmations: [],
      pendingUserInput: null,
      resumeCoordinator: new ResumeSessionCoordinator({
        adapter,
        runtime,
      }),
      turns: new TurnCoordinator<ActiveTask>({
        restoreLastConversationOnFailure: true,
      }),
      lastOutputAt: 0,
      lastFinalReplyAtMs: 0,
      eventForwardChain: Promise.resolve(),
      deferredInputs: [],
      drainingDeferredInputs: false,
    };

    runtime.setEventSink((event) => {
      this.host.onSlotEvent(slot, event);
    });
    await runtime.start();
    controller.syncLocalClientEndpoint();
    this.host.daemonLog(
      `slot_started: adapter=${adapter} command=${resolveDefaultAdapterCommand(adapter)} cwd=${this.host.cwd} session_start_mode=${options.sessionStartMode ?? "restore"}`,
    );
    return slot;
  }

  async startFreshSlotSession(slot: DaemonSlot): Promise<void> {
    await slot.outputBatcher.flushNow();
    slot.outputBatcher.clear();
    slot.pendingConfirmations = [];
    slot.pendingUserInput = null;
    slot.turns.complete();

    if (slot.adapter === "codex" || slot.adapter === "claude") {
      await slot.runtime.reset();
    } else if (slot.adapter === "opencode" || slot.adapter === "pi") {
      if (!slot.runtime.createSession) {
        throw new Error(t("bridge.newSession.unavailable", { adapter: slot.adapter }));
      }
      await slot.runtime.createSession();
    }

    slot.controller.syncLocalClientEndpoint();
  }

  getActiveSlot(): DaemonSlot | null {
    if (!this.activeAdapter) {
      return null;
    }
    return this.slots.get(this.activeAdapter) ?? null;
  }
}
