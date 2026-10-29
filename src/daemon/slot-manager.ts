// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import {
  sameSlotSession,
  toSlotSessionRecord,
  type SlotSessionStore,
} from "./slot-session-store.ts";
import { resolveDefaultAdapterCommand } from "../bridge/bridge-adapters.ts";
import { t } from "../i18n/index.ts";
import { getSharedSessionIdFromAdapterState } from "../bridge/bridge-adapters.shared.ts";
import { BridgeController } from "../bridge/bridge-controller.ts";
import type { BridgeAdapter, BridgeSessionStartMode, BridgeEvent } from "../bridge/bridge-types.ts";
import { formatDuration, OutputBatcher, truncatePreview } from "../bridge/bridge-utils.ts";
import { ResumeSessionCoordinator } from "../bridge/bridge-session-resume.ts";
import type { ChannelSendKind } from "../channels/wechat/wechat-forwarding.ts";
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
  NO_BRIDGE_MODE,
  admitWindow,
  modeAfterWindowClosed,
  windowSourceName,
  type BridgeMode,
  type BridgeModeKind,
  type BridgeWindow,
} from "./bridge-mode.ts";
import {
  type ActiveTask,
  type DaemonSlot,
  type EnsureSlotOptions,
  type EnsureSlotResult,
  isSameWorkspace,
  prefixSourceMessage,
  slotName,
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
  isVisibleClientAlive: (cwd: string, adapter: DaemonAdapterKind, instance?: number) => boolean;
  openVisibleClient: (options: Parameters<typeof openVisibleClient>[0]) => VisibleClientLaunch;
  queueMessage: (
    senderId: string,
    text: string,
    context?: ChannelSendKind,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  resolveSlotOutputTarget: (slot: DaemonSlot) => ChannelConversationRef;
  onSlotEvent: (slot: DaemonSlot, event: BridgeEvent) => void;
  /** Where slots save the session they follow, for later restores. */
  sessions: SlotSessionStore;
  /** An ephemeral daemon binds every slot to its visible window. */
  isEphemeral: () => boolean;
  /** Called after a slot left the map (released or dead). */
  onSlotRemoved?: (slot: DaemonSlot) => void;
  /** A brand-new window finished opening (activated); register it for routing. */
  onSlotCreated?: (
    slot: DaemonSlot,
    info: { openedVisible: boolean; visibleReady: boolean },
  ) => void;
  /** A new slot moved the bridge up a mode; tell the operator what opened up. */
  onModeUpgraded?: (mode: BridgeModeKind, slot: DaemonSlot) => void;
  /**
   * Shortest conversation tag currently bound to this slot (auto session or
   * manual `/pin [tag]`), used to prefix its replies, or null.
   */
  sessionTagForSlot?: (slot: DaemonSlot) => string | null;
  daemonLog: (message: string) => void;
  /**
   * Long-running progress heartbeat: while a slot stays busy, a short
   * "still working" summary is pushed to the operator every interval.
   * Both are ms; defaults are 10 min and 5 min.
   */
  progressHeartbeatIntervalMs?: number;
  progressHeartbeatMinBusyMs?: number;
};

/** How long a window-bound slot waits for its window to connect. */
const WINDOW_STARTUP_GRACE_MS = 60_000;

function slotKey(cwd: string, adapter: DaemonAdapterKind, instance = 1): string {
  return `${workspaceKeyOf(cwd)}\n${adapter}\n${instance}`;
}

/**
 * Owns the daemon's adapter slots across workspaces, the current workspace
 * and adapter, and per-slot serialization. Slots are keyed by workspace,
 * adapter, and instance number, so the same adapter can run in several
 * project directories (and, later, several times in one directory).
 */
export class SlotManager {
  private readonly slotMap = new Map<string, DaemonSlot>();
  // Per-slot serialization chains for ensureSlot (see ensureSlot comment).
  private readonly slotEnsureChains = new Map<string, Promise<unknown>>();
  private readonly slotInputChains = new Map<string, Promise<unknown>>();
  /** Workspaces that stay listed even without slots (startup, wechat-daemon). */
  private readonly registeredWorkspaces: string[] = [];
  /** Admitted windows whose slot is still being created. */
  private readonly reservedWindows: BridgeWindow[] = [];
  /** How much of the multi-bridge surface is exposed; only moves up. */
  mode: BridgeMode = NO_BRIDGE_MODE;
  private currentCwd: string;
  /** Home workspace: the current one while no window is open. */
  private home: string;
  activeAdapter: DaemonAdapterKind | null = null;
  /** Which numbered window of the active adapter the operator is on. */
  activeInstance = 1;
  private activeAdapterVersion = 0;
  takenOverAdapter?: DaemonAdapterKind;
  private readonly host: SlotManagerHost;
  private readonly progressHeartbeatIntervalMs: number;
  private readonly progressHeartbeatMinBusyMs: number;
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastHeartbeatAt = new Map<string, number>();

  constructor(host: SlotManagerHost) {
    this.host = host;
    this.currentCwd = host.cwd;
    this.home = host.cwd;
    this.registeredWorkspaces.push(host.cwd);
    this.progressHeartbeatIntervalMs = host.progressHeartbeatIntervalMs ?? 600_000;
    this.progressHeartbeatMinBusyMs = host.progressHeartbeatMinBusyMs ?? 300_000;
  }

  /** Current workspace; falls back to the startup workspace once it is gone. */
  get activeCwd(): string {
    if (!this.hasWorkspace(this.currentCwd)) {
      this.currentCwd = this.home;
      this.activeAdapter = null;
    }
    return this.currentCwd;
  }

  allSlots(): DaemonSlot[] {
    return Array.from(this.slotMap.values());
  }

  /**
   * A slot of `adapter` in `cwd`: the given instance, or without one the
   * instance the operator is on there, else the most recently used one.
   */
  getSlot(cwd: string, adapter: DaemonAdapterKind, instance?: number): DaemonSlot | undefined {
    if (instance !== undefined) {
      return this.slotMap.get(slotKey(cwd, adapter, instance));
    }
    const instances = this.instancesOf(cwd, adapter);
    const active = this.activeAdapter === adapter && isSameWorkspace(cwd, this.currentCwd)
      ? instances.find((slot) => slot.instance === this.activeInstance)
      : undefined;
    return active ??
      instances.reduce<DaemonSlot | undefined>(
        (latest, slot) => !latest || slot.activatedAtMs > latest.activatedAtMs ? slot : latest,
        undefined,
      );
  }

  /** Every window the bridge holds or is opening, for mode decisions. */
  windows(): BridgeWindow[] {
    return [
      ...this.allSlots().map(({ cwd, adapter, instance }) => ({ cwd, adapter, instance })),
      ...this.reservedWindows,
    ];
  }

  /** Every instance of `adapter` in `cwd`, lowest number first. */
  instancesOf(cwd: string, adapter: DaemonAdapterKind): DaemonSlot[] {
    return this.slotsIn(cwd).filter((slot) => slot.adapter === adapter);
  }

  /** Slots of one workspace in canonical adapter order, then instance. */
  slotsIn(cwd: string): DaemonSlot[] {
    return this.allSlots()
      .filter((slot) => isSameWorkspace(slot.cwd, cwd))
      .sort((left, right) =>
        DAEMON_ADAPTERS.indexOf(left.adapter) - DAEMON_ADAPTERS.indexOf(right.adapter) ||
        left.instance - right.instance);
  }

  /** `wechat-daemon` started in `cwd`: it becomes the home workspace. */
  setHome(cwd: string): void {
    this.home = cwd;
    this.registerWorkspace(cwd);
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

  /**
   * How a slot is named to the operator: `codex`, or `workspace/codex` once
   * the bridge spans several workspaces.
   */
  sourceName(cwd: string, name: string): string {
    return this.mode.kind === "multi_workspace" ? `${this.workspaceLabel(cwd)}/${name}` : name;
  }

  /** Name of one slot for the operator, e.g. `pi-2` or `my-app/codex`. */
  slotSourceName(slot: DaemonSlot): string {
    return windowSourceName(this.mode, slot, this.allSlots(), (cwd) => this.workspaceLabel(cwd)) ??
      slotName(slot);
  }

  /**
   * Prefix slot output with its source, e.g. `[codex]`, `[pi-1]`,
   * `[my-app/codex]`, or `[passt-2]` when the slot has a conversation tag
   * (auto session or `/pin [tag]`); a single bridge adds none.
   */
  prefix(slot: DaemonSlot, text: string): string {
    const tag = this.host.sessionTagForSlot?.(slot) ?? null;
    const source = tag ?? windowSourceName(this.mode, slot, this.allSlots(), (cwd) => this.workspaceLabel(cwd));
    return source ? prefixSourceMessage(source, text) : text;
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
    this.activeInstance = next?.instance ?? 1;
    if (next) next.activatedAtMs = Date.now();
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
    this.removeSlot(slot, "dead_slot_disposed");
  }

  /** A window-bound slot whose visible window closed. */
  releaseSlot(slot: DaemonSlot): void {
    this.removeSlot(slot, "slot_released");
  }

  private removeSlot(slot: DaemonSlot, event: string): void {
    const key = slotKey(slot.cwd, slot.adapter, slot.instance);
    if (this.slotMap.get(key) !== slot) {
      return; // Already replaced by a newer ensureSlot run.
    }
    this.slotMap.delete(key);
    this.stopProgressHeartbeat(slot);
    if (
      this.activeAdapter === slot.adapter &&
      this.activeInstance === slot.instance &&
      isSameWorkspace(slot.cwd, this.currentCwd)
    ) {
      this.activeAdapter = null;
    }
    this.host.daemonLog(`${event}: adapter=${slot.adapter} instance=${slot.instance} cwd=${slot.cwd}`);
    const mode = modeAfterWindowClosed(this.mode, this.windows().length, !this.host.isEphemeral());
    if (mode !== this.mode) {
      // A resident daemon left without windows starts over from its home.
      this.host.daemonLog(`bridge_mode_reset: from=${this.mode.kind}`);
      this.mode = mode;
      this.currentCwd = this.home;
      this.activeAdapter = null;
    }
    this.host.onSlotRemoved?.(slot);
    void (async () => {
      try {
        await slot.runtime.dispose();
      } catch {
        // Best effort: the runtime already stopped or is stopping.
      }
      slot.controller.clearLocalClientEndpoint();
    })();
  }

  restoreActiveAdapterAfterRejectedInput(
    adapter: DaemonAdapterKind,
    activationVersion: number,
    previousActiveAdapter: DaemonAdapterKind | null,
    previousActiveCwd: string = this.currentCwd,
    previousActiveInstance = 1,
  ): void {
    if (this.activeAdapter === adapter && this.activeAdapterVersion === activationVersion) {
      this.activeAdapter = previousActiveAdapter;
      this.activeInstance = previousActiveInstance;
      this.currentCwd = previousActiveCwd;
      this.activeAdapterVersion += 1;
    }
  }

  serializeSlotInput<T>(slot: DaemonSlot, task: () => Promise<T>): Promise<T> {
    const key = slotKey(slot.cwd, slot.adapter, slot.instance);
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
    let instance = options.instance ??
      (options.newInstance ? undefined : this.getSlot(cwd, adapter)?.instance);
    let reservation: BridgeWindow | undefined;
    let upgradedTo: BridgeModeKind | undefined;
    if (instance === undefined) {
      // A new window: the bridge mode decides whether it may join. Admission
      // is synchronous, so concurrent requests see each other's reservation.
      const admission = admitWindow(this.mode, this.windows(), { cwd, adapter });
      if (!admission.admitted) {
        this.host.daemonLog(`window_refused: adapter=${adapter} cwd=${cwd} mode=${this.mode.kind} reason=${admission.reason}`);
        return this.refusedResult(adapter, cwd, admission.reason);
      }
      if (admission.upgradedTo) {
        this.host.daemonLog(`bridge_mode_upgraded: from=${this.mode.kind} to=${admission.upgradedTo} adapter=${adapter} cwd=${cwd}`);
        upgradedTo = admission.upgradedTo;
      }
      this.mode = admission.mode;
      instance = admission.instance;
      reservation = { cwd, adapter, instance };
      this.reservedWindows.push(reservation);
    }
    const slotInstance = instance;
    const key = slotKey(cwd, adapter, slotInstance);
    const tail = this.slotEnsureChains.get(key) ?? Promise.resolve();
    const run = tail.then(
      () => this.runEnsureSlot(adapter, cwd, slotInstance, options),
      // A rejected predecessor must not block this run — start fresh either way.
      () => this.runEnsureSlot(adapter, cwd, slotInstance, options),
    );
    this.slotEnsureChains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    if (!reservation) {
      return run;
    }
    const reserved = reservation;
    try {
      const result = await run;
      const slot = this.getSlot(cwd, adapter, slotInstance);
      if (upgradedTo && slot) {
        this.host.onModeUpgraded?.(upgradedTo, slot);
      }
      return upgradedTo ? { ...result, upgradedTo } : result;
    } finally {
      this.reservedWindows.splice(this.reservedWindows.indexOf(reserved), 1);
      if (!this.getSlot(cwd, adapter, slotInstance)) {
        // The window never got a slot; a resident daemon left empty starts over.
        this.mode = modeAfterWindowClosed(this.mode, this.windows().length, !this.host.isEphemeral());
      }
    }
  }

  private refusedResult(
    adapter: DaemonAdapterKind,
    cwd: string,
    refused: NonNullable<EnsureSlotResult["refused"]>,
  ): EnsureSlotResult {
    return {
      activeAdapter: adapter,
      cwd,
      instance: 0,
      created: false,
      openedVisible: false,
      visibleConnected: false,
      visibleReady: false,
      activated: false,
      activationVersion: this.activeAdapterVersion,
      previousActiveAdapter: this.activeAdapter ?? undefined,
      previousActiveInstance: this.activeInstance,
      previousActiveCwd: this.activeCwd,
      refused,
    };
  }

  private async runEnsureSlot(
    adapter: DaemonAdapterKind,
    cwd: string,
    instance: number,
    options: EnsureSlotOptions = {},
  ): Promise<EnsureSlotResult> {
    const previousActiveAdapter = this.activeAdapter ?? undefined;
    const previousActiveInstance = this.activeInstance;
    const previousActiveCwd = this.activeCwd;
    let slot = this.getSlot(cwd, adapter, instance);
    let created = false;
    if (!slot) {
      const takenOver = adapter === this.takenOverAdapter && isSameWorkspace(cwd, this.home);
      const createSessionStartMode =
        options.sessionStartMode ??
        (takenOver ? "restore" : defaultDaemonSessionStartMode(adapter));
      if (takenOver) {
        this.takenOverAdapter = undefined;
      }
      slot = await this.createSlot(adapter, cwd, instance, {
        profile: options.profile ?? this.host.profile,
        sessionStartMode: options.codexAttach ? "new" : createSessionStartMode,
        // An attached slot follows the Codex TUI that owns the thread, not a window.
        boundToWindow: !options.codexAttach &&
          (options.boundToWindow === true || this.host.isEphemeral()),
        codexAttach: options.codexAttach,
      });
      this.slotMap.set(slotKey(cwd, adapter, instance), slot);
      created = true;
    }

    let openedVisible = false;
    const visibleEndpointBeforeProbe = readLocalCompanionEndpoint(cwd, {
      adapter,
      instance,
    });
    const hadVisibleClient = Boolean(
      visibleEndpointBeforeProbe?.companionPid ||
        visibleEndpointBeforeProbe?.companionConnectedAt ||
        visibleEndpointBeforeProbe?.sharedThreadId ||
        visibleEndpointBeforeProbe?.sharedSessionId,
    );
    let visibleConnected = this.host.isVisibleClientAlive(cwd, adapter, instance);
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
      const source = this.slotSourceName(slot);
      void this.host.queueMessage(this.host.operatorId, t("daemon.opening", { source }));
      const launch = this.host.openVisibleClient({
        adapter,
        cwd,
        instance,
        title: `${this.host.channelId}-${slotName(slot)} · ${this.workspaceLabel(cwd)}`,
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
        cwd,
        adapter,
        instance,
        timeoutMs: this.host.visibleClientConnectTimeoutMs,
      }, {
        isAlive: (cwd, adapter, instance) => this.host.isVisibleClientAlive(cwd, adapter, instance),
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
      this.activeInstance = instance;
      this.activeAdapterVersion += 1;
      slot.activatedAtMs = Date.now();
    }

    this.host.daemonLog(
      `switch_adapter: adapter=${adapter} instance=${instance} created=${created} opened_visible=${openedVisible} visible_connected=${visibleConnected} visible_ready=${visibleReady} activated=${activated} previous_active=${previousActiveAdapter ?? "(none)"} cwd=${cwd} session_start_mode=${sessionStartMode}`,
    );
    if (created && activated) {
      this.host.onSlotCreated?.(slot, { openedVisible, visibleReady });
    }
    return {
      activeAdapter: adapter,
      cwd,
      instance,
      created,
      openedVisible,
      visibleConnected,
      visibleReady,
      activated,
      activationVersion: this.activeAdapterVersion,
      previousActiveAdapter,
      previousActiveInstance,
      previousActiveCwd,
      ...(slot.runtime.getState().sharedThreadId
        ? { sharedThreadId: slot.runtime.getState().sharedThreadId }
        : {}),
    };
  }

  private async createSlot(
    adapter: DaemonAdapterKind,
    cwd: string,
    instance: number,
    options: {
      profile?: string;
      sessionStartMode?: BridgeSessionStartMode;
      boundToWindow: boolean;
      codexAttach?: { threadId?: string };
    },
  ): Promise<DaemonSlot> {
    clearLocalCompanionEndpoint(cwd, undefined, { adapter, instance });
    // An explicit restore resumes the session this slot followed last time.
    const restored = options.sessionStartMode === "restore"
      ? this.host.sessions.read(cwd, adapter, instance)
      : null;
    if (restored?.sharedSessionId) {
      this.host.daemonLog(`slot_session_restore: adapter=${adapter} cwd=${cwd} session=${restored.sharedSessionId}`);
    }
    const runtime = this.host.createRuntime({
      kind: adapter,
      command: resolveDefaultAdapterCommand(adapter),
      cwd,
      profile: options.profile,
      // A window-bound slot asks to stop when its visible client closes.
      lifecycle: options.boundToWindow ? "companion_bound" : "persistent",
      sessionStartMode: options.sessionStartMode,
      initialSharedSessionId: restored?.sharedSessionId,
      initialResumeConversationId: restored?.resumeConversationId,
      initialTranscriptPath: restored?.transcriptPath,
      ...(options.codexAttach
        ? { codexAttachDaemon: true, codexAttachThreadId: options.codexAttach.threadId }
        : {}),
      companionLaunchMode: "daemon_auto",
      ...(instance > 1 ? { slotInstance: instance } : {}),
    });
    const controller = new BridgeController(runtime, cwd, instance);
    const slot: DaemonSlot = {
      adapter,
      cwd,
      instance,
      boundToWindow: options.boundToWindow,
      attached: Boolean(options.codexAttach),
      createdAtMs: Date.now(),
      activatedAtMs: 0,
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
      autoApprovals: {},
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
      `slot_started: adapter=${adapter} instance=${instance} command=${resolveDefaultAdapterCommand(adapter)} cwd=${cwd} session_start_mode=${options.sessionStartMode ?? "restore"}`,
    );
    this.startProgressHeartbeat(slot);
    void this.hydrateSlotSessionTitle(slot);
    return slot;
  }

  /**
   * A window may carry its own session name (codex /rename). Read it once the
   * window is connected and, when it differs from the cwd basename, re-run the
   * auto-session registration so the [tag] follows the CLI's own name.
   */
  private async hydrateSlotSessionTitle(slot: DaemonSlot): Promise<void> {
    const runtime = slot.runtime as { readCodexThreadTitle?: () => Promise<string | null> };
    if (typeof runtime.readCodexThreadTitle !== "function") {
      return;
    }
    try {
      const title = await runtime.readCodexThreadTitle();
      const cleaned = title?.replace(/\[|\]/g, "").trim();
      if (!cleaned || cleaned === path.basename(slot.cwd)) {
        return;
      }
      slot.sessionTitle = cleaned.slice(0, 20);
      this.host.onSlotCreated?.(slot, { openedVisible: false, visibleReady: true });
    } catch {
      // Best effort: keep the cwd-basename tag when the title cannot be read.
    }
  }

  /**
   * A compact progress snapshot for one slot: how long the current run has
   * been going and the most recent output summary. Used by status queries
   * (`[tag]` bare lookups) and by the long-task heartbeat.
   */
  slotProgressSummary(slot: DaemonSlot): { runningForMs: number; recentText: string } {
    const state = slot.runtime.getState();
    const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : slot.createdAtMs;
    const runningForMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
    return {
      runningForMs,
      recentText: slot.outputBatcher.getRecentSummary(140),
    };
  }

  private startProgressHeartbeat(slot: DaemonSlot): void {
    const key = slotKey(slot.cwd, slot.adapter, slot.instance);
    if (this.heartbeatTimers.has(key)) {
      return;
    }
    const timer = setInterval(() => this.maybeSendProgressHeartbeat(slot), this.progressHeartbeatIntervalMs);
    // setInterval returns a NodeJS.Timer on Node and a number in the DOM; keep
    // whatever unref-style unwrapping the runtime expects. Do not unref here:
    // the daemon must stay alive to deliver the heartbeat.
    this.heartbeatTimers.set(key, timer);
  }

  private stopProgressHeartbeat(slot: DaemonSlot): void {
    const key = slotKey(slot.cwd, slot.adapter, slot.instance);
    const timer = this.heartbeatTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(key);
      this.lastHeartbeatAt.delete(key);
    }
  }

  private maybeSendProgressHeartbeat(slot: DaemonSlot): void {
    const state = slot.runtime.getState();
    if (state.status !== "busy") {
      return;
    }
    const { runningForMs, recentText } = this.slotProgressSummary(slot);
    if (runningForMs < this.progressHeartbeatMinBusyMs) {
      return;
    }
    const key = slotKey(slot.cwd, slot.adapter, slot.instance);
    const last = this.lastHeartbeatAt.get(key) ?? 0;
    if (Date.now() - last < this.progressHeartbeatIntervalMs) {
      return;
    }
    this.lastHeartbeatAt.set(key, Date.now());
    void this.host.queueMessage(
      this.host.operatorId,
      this.prefix(
        slot,
        t("daemon.heartbeat", {
          runningFor: formatDuration(runningForMs),
          recentText: recentText || t("daemon.heartbeat.noRecent"),
        }),
      ),
      "message",
    );
  }

  async startFreshSlotSession(slot: DaemonSlot): Promise<void> {
    await slot.outputBatcher.flushNow();
    slot.outputBatcher.clear();
    slot.pendingConfirmations = [];
    slot.pendingUserInput = null;
    slot.knownThreadId = undefined;
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
    return this.getSlot(cwd, this.activeAdapter, this.activeInstance) ?? null;
  }

  /**
   * Release window-bound slots whose window is gone. Adapters do not all
   * report a closed window (Codex keeps its app-server in the daemon), so the
   * daemon checks the companion itself: a window seen once and then missing
   * on two checks in a row, or never seen within the startup grace, ends the
   * slot.
   */
  releaseClosedWindows(nowMs = Date.now()): void {
    for (const slot of this.allSlots()) {
      if (!slot.boundToWindow) {
        continue;
      }
      if (this.host.isVisibleClientAlive(slot.cwd, slot.adapter, slot.instance)) {
        slot.windowSeen = true;
        slot.windowMissingChecks = 0;
        continue;
      }
      if (!slot.windowSeen) {
        if (nowMs - slot.createdAtMs >= WINDOW_STARTUP_GRACE_MS) {
          this.host.daemonLog(`window_never_connected: adapter=${slot.adapter} cwd=${slot.cwd}`);
          this.releaseSlot(slot);
        }
        continue;
      }
      slot.windowMissingChecks = (slot.windowMissingChecks ?? 0) + 1;
      if (slot.windowMissingChecks >= 2) {
        this.releaseSlot(slot);
      }
    }
  }

  /** Save the session a slot follows whenever it changes. */
  syncSession(slot: DaemonSlot): void {
    const record = toSlotSessionRecord(slot.runtime.getState());
    if (!record.sharedSessionId || sameSlotSession(slot.savedSession ?? null, record)) {
      return;
    }
    try {
      this.host.sessions.write(slot.cwd, slot.adapter, record, slot.instance);
      slot.savedSession = record;
    } catch (error) {
      this.host.daemonLog(`slot_session_save_failed: adapter=${slot.adapter} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Remove every slot (shutdown); returns the removed slots. */
  clear(): DaemonSlot[] {
    const removed = this.allSlots();
    this.slotMap.clear();
    return removed;
  }
}
