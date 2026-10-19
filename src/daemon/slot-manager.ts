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
import { DAEMON_ADAPTERS, log } from "./daemon-shared.ts";
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
  type EnsureSlotOptions,
  type EnsureSlotResult,
  isSameWorkspace,
  prefixSourceMessage,
  workspaceKeyOf,
  workspaceLabels,
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

function slotKey(cwd: string, adapter: DaemonAdapterKind): string {
  return `${workspaceKeyOf(cwd)}\n${adapter}`;
}

/**
 * Owns the daemon's adapter slots across workspaces, the current workspace
 * and adapter, and per-slot serialization. Slots are keyed by workspace and
 * adapter, so the same adapter can run in several project directories.
 */
export class SlotManager {
  private readonly slotMap = new Map<string, DaemonSlot>();
  // Per-slot serialization chains for ensureSlot (see ensureSlot comment).
  private readonly slotEnsureChains = new Map<string, Promise<unknown>>();
  private readonly slotInputChains = new Map<string, Promise<unknown>>();
  /** Workspaces that stay listed even without slots (startup, wechat-daemon). */
  private readonly registeredWorkspaces: string[] = [];
  private currentCwd: string;
  activeAdapter: DaemonAdapterKind | null = null;
  private activeAdapterVersion = 0;
  takenOverAdapter?: DaemonAdapterKind;
  private readonly host: SlotManagerHost;

  constructor(host: SlotManagerHost) {
    this.host = host;
    this.currentCwd = host.cwd;
    this.registeredWorkspaces.push(host.cwd);
  }

  /** Current workspace; falls back to the startup workspace once it is gone. */
  get activeCwd(): string {
    if (!this.hasWorkspace(this.currentCwd)) {
      this.currentCwd = this.host.cwd;
      this.activeAdapter = null;
    }
    return this.currentCwd;
  }

  allSlots(): DaemonSlot[] {
    return Array.from(this.slotMap.values());
  }

  getSlot(cwd: string, adapter: DaemonAdapterKind): DaemonSlot | undefined {
    return this.slotMap.get(slotKey(cwd, adapter));
  }

  /** Slots of one workspace in canonical adapter order. */
  slotsIn(cwd: string): DaemonSlot[] {
    return DAEMON_ADAPTERS
      .map((adapter) => this.getSlot(cwd, adapter))
      .filter((slot): slot is DaemonSlot => Boolean(slot));
  }

  /** Listed workspaces: registered ones first, then any with a live slot. */
  workspaces(): string[] {
    const listed: string[] = [];
    for (const cwd of [...this.registeredWorkspaces, ...this.allSlots().map((slot) => slot.cwd)]) {
      if (!listed.some((existing) => isSameWorkspace(existing, cwd))) {
        listed.push(cwd);
      }
    }
    return listed;
  }

  hasWorkspace(cwd: string): boolean {
    return this.workspaces().some((existing) => isSameWorkspace(existing, cwd));
  }

  registerWorkspace(cwd: string): void {
    if (!this.registeredWorkspaces.some((existing) => isSameWorkspace(existing, cwd))) {
      this.registeredWorkspaces.push(cwd);
    }
  }

  isActiveWorkspace(cwd: string): boolean {
    return isSameWorkspace(cwd, this.activeCwd);
  }

  workspaceLabel(cwd: string): string {
    const listed = this.workspaces();
    const match = listed.find((existing) => isSameWorkspace(existing, cwd));
    return workspaceLabels(match ? listed : [...listed, cwd]).get(match ?? cwd) ?? cwd;
  }

  /** `[adapter]` for the current workspace, `[workspace/adapter]` otherwise. */
  prefix(slot: DaemonSlot, text: string): string {
    const source = this.isActiveWorkspace(slot.cwd)
      ? slot.adapter
      : `${this.workspaceLabel(slot.cwd)}/${slot.adapter}`;
    return prefixSourceMessage(source, text);
  }

  /**
   * Make another listed workspace current. Keeps the same adapter when that
   * workspace runs it, otherwise picks its first running slot.
   */
  switchWorkspace(cwd: string): DaemonSlot | null {
    const target = this.workspaces().find((existing) => isSameWorkspace(existing, cwd)) ?? cwd;
    const previousSlot = this.getActiveSlot();
    this.currentCwd = target;
    const sameAdapter = this.activeAdapter ? this.getSlot(target, this.activeAdapter) : undefined;
    const next = sameAdapter ?? this.slotsIn(target)[0] ?? null;
    if (previousSlot && previousSlot !== next) invalidateModelSnapshot(previousSlot.runtime);
    this.activeAdapter = next?.adapter ?? null;
    this.activeAdapterVersion += 1;
    return next;
  }

  /**
   * Remove a slot whose runtime reported a fatal (terminal) error. The dead
   * runtime would otherwise stay in the slot map forever: every later message
   * would fail against it ("adapter is not running") with no path back to a
   * working adapter short of a manual /reset or daemon restart. After removal,
   * the next switch directive (/codex etc.) rebuilds the adapter from scratch.
   */
  disposeDeadSlot(slot: DaemonSlot): void {
    const key = slotKey(slot.cwd, slot.adapter);
    if (this.slotMap.get(key) !== slot) {
      return; // Already replaced by a newer ensureSlot run.
    }
    this.slotMap.delete(key);
    if (this.activeAdapter === slot.adapter && isSameWorkspace(slot.cwd, this.currentCwd)) {
      this.activeAdapter = null;
    }
    this.host.daemonLog(`dead_slot_disposed: adapter=${slot.adapter} cwd=${slot.cwd}`);
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
    previousActiveCwd: string = this.currentCwd,
  ): void {
    if (this.activeAdapter === adapter && this.activeAdapterVersion === activationVersion) {
      this.activeAdapter = previousActiveAdapter;
      this.currentCwd = previousActiveCwd;
      this.activeAdapterVersion += 1;
    }
  }

  serializeSlotInput<T>(slot: DaemonSlot, task: () => Promise<T>): Promise<T> {
    const key = slotKey(slot.cwd, slot.adapter);
    const tail = this.slotInputChains.get(key) ?? Promise.resolve();
    const run = tail.then(task, task);
    this.slotInputChains.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  async ensureSlot(
    adapter: DaemonAdapterKind,
    options: EnsureSlotOptions = {},
  ): Promise<EnsureSlotResult> {
    // Serialize ensureSlot runs per workspace and adapter. The IPC handler, the WeChat poll
    // loop, and startup can all call this concurrently; without serialization
    // two callers would both observe an empty slot map, create two runtimes,
    // and the second slots.set would orphan the first (duplicate PTY child,
    // double visible client, endpoint files overwriting each other).
    const cwd = options.cwd ?? this.activeCwd;
    const key = slotKey(cwd, adapter);
    const tail = this.slotEnsureChains.get(key) ?? Promise.resolve();
    const run = tail.then(
      () => this.runEnsureSlot(adapter, cwd, options),
      // A rejected predecessor must not block this run — start fresh either way.
      () => this.runEnsureSlot(adapter, cwd, options),
    );
    this.slotEnsureChains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async runEnsureSlot(
    adapter: DaemonAdapterKind,
    cwd: string,
    options: EnsureSlotOptions = {},
  ): Promise<EnsureSlotResult> {
    const previousActiveAdapter = this.activeAdapter ?? undefined;
    const previousActiveCwd = this.activeCwd;
    let slot = this.getSlot(cwd, adapter);
    let created = false;
    if (!slot) {
      const takenOver = adapter === this.takenOverAdapter && isSameWorkspace(cwd, this.host.cwd);
      const createSessionStartMode =
        options.sessionStartMode ??
        (takenOver ? "restore" : defaultDaemonSessionStartMode(adapter));
      if (takenOver) {
        this.takenOverAdapter = undefined;
      }
      slot = await this.createSlot(adapter, cwd, {
        profile: options.profile ?? this.host.profile,
        sessionStartMode: createSessionStartMode,
      });
      this.slotMap.set(slotKey(cwd, adapter), slot);
      created = true;
    }

    let openedVisible = false;
    const visibleEndpointBeforeProbe = readLocalCompanionEndpoint(cwd, {
      adapter,
    });
    const hadVisibleClient = Boolean(
      visibleEndpointBeforeProbe?.companionPid ||
        visibleEndpointBeforeProbe?.companionConnectedAt ||
        visibleEndpointBeforeProbe?.sharedThreadId ||
        visibleEndpointBeforeProbe?.sharedSessionId,
    );
    let visibleConnected = this.host.isVisibleClientAlive(cwd, adapter);
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
        `dead_visible_codex_runtime_restarted: cwd=${cwd}`,
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
        cwd: cwd,
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
        `visible_client_open_attempt: adapter=${adapter} cwd=${cwd} pid=${launch.pid ?? "unknown"} command=${truncatePreview(formatLaunchPreview(launch), 400)}`,
      );
      visibleConnected = await waitForVisibleClientConnection({
        cwd: cwd,
        adapter,
        timeoutMs: this.host.visibleClientConnectTimeoutMs,
      }, {
        isAlive: (cwd, adapter) => this.host.isVisibleClientAlive(cwd, adapter),
      });
      if (visibleConnected) {
        this.host.daemonLog(`visible_client_connected: adapter=${adapter} cwd=${cwd}`);
      } else {
        log(
          `${adapter} visible CLI did not connect within ${formatDuration(visibleClientTimeoutMs)}. Check ${BRIDGE_LOG_FILE}.`,
        );
        const cleanedLauncher = cleanupVisibleClientLauncher(launch);
        this.host.daemonLog(
          `visible_client_connect_timeout: adapter=${adapter} cwd=${cwd} timeout_ms=${visibleClientTimeoutMs} cleaned_launcher=${cleanedLauncher}`,
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
          `visible_codex_thread_ready: thread=${visibleThreadId} cwd=${cwd}`,
        );
      } else {
        this.host.daemonLog(
          `visible_codex_thread_timeout: cwd=${cwd} timeout_ms=${VISIBLE_CLIENT_CONNECT_TIMEOUT_MS}`,
        );
      }
    }

    const activated = options.openVisible === false || (visibleConnected && visibleReady);
    if (activated && options.activate !== false) {
      const previousSlot = this.getActiveSlot();
      if (previousSlot && previousSlot !== slot) invalidateModelSnapshot(previousSlot.runtime);
      this.currentCwd = cwd;
      this.activeAdapter = adapter;
      this.activeAdapterVersion += 1;
    }

    this.host.daemonLog(
      `switch_adapter: adapter=${adapter} created=${created} opened_visible=${openedVisible} visible_connected=${visibleConnected} visible_ready=${visibleReady} activated=${activated} previous_active=${previousActiveAdapter ?? "(none)"} cwd=${cwd} session_start_mode=${sessionStartMode}`,
    );
    return {
      activeAdapter: adapter,
      cwd,
      created,
      openedVisible,
      visibleConnected,
      visibleReady,
      activated,
      activationVersion: this.activeAdapterVersion,
      previousActiveAdapter,
      previousActiveCwd,
    };
  }

  private async createSlot(
    adapter: DaemonAdapterKind,
    cwd: string,
    options: { profile?: string; sessionStartMode?: BridgeSessionStartMode },
  ): Promise<DaemonSlot> {
    clearLocalCompanionEndpoint(cwd, undefined, { adapter });
    const runtime = this.host.createRuntime({
      kind: adapter,
      command: resolveDefaultAdapterCommand(adapter),
      cwd: cwd,
      profile: options.profile,
      lifecycle: "persistent",
      sessionStartMode: options.sessionStartMode,
      companionLaunchMode: "daemon_auto",
    });
    const controller = new BridgeController(runtime, cwd);
    const slot: DaemonSlot = {
      adapter,
      cwd,
      runtime,
      controller,
      outputBatcher: new OutputBatcher(async (text) => {
        await this.host.queueMessage(
          this.host.operatorId,
          this.prefix(slot, text),
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
      `slot_started: adapter=${adapter} command=${resolveDefaultAdapterCommand(adapter)} cwd=${cwd} session_start_mode=${options.sessionStartMode ?? "restore"}`,
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
    const cwd = this.activeCwd;
    if (!this.activeAdapter) {
      return null;
    }
    return this.getSlot(cwd, this.activeAdapter) ?? null;
  }

  /** Remove every slot (shutdown); returns the removed slots. */
  clear(): DaemonSlot[] {
    const removed = this.allSlots();
    this.slotMap.clear();
    return removed;
  }
}
