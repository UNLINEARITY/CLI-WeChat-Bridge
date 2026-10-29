// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import crypto from "node:crypto";

import { t } from "../i18n/index.ts";
import type { ApprovalDecision } from "../bridge/bridge-types.ts";
import { nowIso, truncatePreview } from "../bridge/bridge-utils.ts";
import type { ChannelSendKind } from "../channels/wechat/wechat-forwarding.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";
import {
  type ActiveTask,
  type DaemonSlot,
  isSameWorkspace,
  slotName,
  toPendingApproval,
  workspaceKeyOf,
} from "./daemon-slot.ts";
import type { SlotManager } from "./slot-manager.ts";
import type { TypingTracker } from "./typing-tracker.ts";

/**
 * A slot named by workspace and adapter, plus an instance number or a
 * display name such as `codex-w1`; without either, the operator's window.
 */
export type AgentRef = {
  cwd: string;
  adapter: DaemonAdapterKind;
  instance?: number;
  name?: string;
};

export type AgentCallStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "interrupted";

/** Decisions a calling agent may take on its callee's approval. */
export type AgentApprovalDecision = Extract<ApprovalDecision, "confirm" | "deny" | "abort">;

export type AgentCallView = {
  callId: string;
  status: AgentCallStatus;
  caller?: string;
  target: string;
  targetCwd: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  queuePosition?: number;
  reply?: string;
  error?: string;
  pendingApproval?: {
    requestId?: string;
    summary: string;
    commandPreview: string;
    /** The caller may confirm it; a high-risk request waits for the operator. */
    callerMayConfirm: boolean;
  };
  pendingUserInput?: { summary: string };
};

export type AgentSummary = {
  name: string;
  adapter: DaemonAdapterKind;
  instance: number;
  cwd: string;
  status: string;
  idle: boolean;
  queuedCalls: number;
  activeCallId?: string;
  /** Opened by an agent; `owner` names it (absent for an external tool). */
  worker?: { owner?: string };
};

type AgentCall = {
  callId: string;
  caller?: AgentRef & { instance: number };
  target: AgentRef & { instance: number };
  text: string;
  /** Slot keys of every agent above this call, the direct caller last. */
  chain: string[];
  status: AgentCallStatus;
  reply?: string;
  error?: string;
  createdAtMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  /** The caller read the result itself; it is not delivered as a turn. */
  consumed: boolean;
  interruptRequested: boolean;
  waiters: Array<() => void>;
};

/** Something waiting to be told to a calling agent as a new turn. */
type AgentDelivery = { callId: string; kind: "result" | "approval"; requestId?: string };

export type AgentBusHost = {
  slotManager: SlotManager;
  typing: TypingTracker;
  operatorId: string;
  queueMessage: (senderId: string, text: string, context?: ChannelSendKind) => Promise<boolean>;
  daemonLog: (message: string) => void;
};

const MAX_CALL_DEPTH = 3;
const MAX_WORKERS_PER_OWNER = 4;
const MAX_QUEUED_CALLS = 8;
const MAX_WAIT_MS = 50_000;
const SETTLED_RETENTION_MS = 60 * 60_000;
const SETTLED_STATUSES = new Set<AgentCallStatus>(["completed", "failed", "interrupted"]);
const BUSY_STATUSES = new Set(["starting", "busy", "awaiting_approval", "awaiting_input", "stopped", "error"]);

function agentKey(ref: { cwd: string; adapter: DaemonAdapterKind; instance: number }): string {
  return `${workspaceKeyOf(ref.cwd)}\n${ref.adapter}\n${ref.instance}`;
}

function refOf(slot: DaemonSlot): AgentRef & { instance: number } {
  return { cwd: slot.cwd, adapter: slot.adapter, instance: slot.instance };
}

/**
 * Calls between the daemon's CLI slots. A call works like a background task
 * of the caller: it runs as a turn of the target slot (queued while the
 * target is busy), the caller can poll it, and its result is delivered back
 * to the caller as a new turn unless the caller read it first.
 */
export class AgentBus {
  private readonly calls = new Map<string, AgentCall>();
  private readonly queues = new Map<DaemonSlot, string[]>();
  private readonly deliveries = new Map<DaemonSlot, AgentDelivery[]>();
  private readonly draining = new Set<DaemonSlot>();
  private readonly host: AgentBusHost;

  constructor(host: AgentBusHost) {
    this.host = host;
  }

  list(): AgentSummary[] {
    return this.host.slotManager.everySlot().map((slot) => this.summary(slot));
  }

  /**
   * Open a worker for the caller: a fresh session of `adapter` outside the
   * bridge mode. A Codex worker runs without a window unless asked; the
   * other CLIs always run in a visible window.
   */
  async open(params: { caller?: AgentRef; adapter: DaemonAdapterKind; cwd?: string; visible?: boolean }): Promise<AgentSummary> {
    const slots = this.host.slotManager;
    const callerSlot = this.requireCaller(params.caller);
    const ownerKey = callerSlot ? agentKey(refOf(callerSlot)) : undefined;
    const owned = slots.workerSlots().filter((slot) => slot.worker?.ownerKey === ownerKey).length;
    if (owned >= MAX_WORKERS_PER_OWNER) {
      throw new Error(`An agent may keep at most ${MAX_WORKERS_PER_OWNER} workers open; close one first.`);
    }
    const cwd = params.cwd || callerSlot?.cwd || slots.activeCwd;
    const visible = params.adapter === "codex" ? params.visible === true : true;
    const result = await slots.ensureSlot(params.adapter, {
      cwd,
      worker: { ...(ownerKey ? { ownerKey } : {}), ...(callerSlot ? { ownerName: slotName(callerSlot) } : {}) },
      openVisible: visible,
      sessionStartMode: "new",
      reuseExistingVisible: false,
    });
    const slot = slots.getSlot(cwd, params.adapter, result.instance);
    if (!slot) throw new Error(`${params.adapter} worker could not be opened in ${cwd}.`);
    if (visible && !result.visibleConnected) {
      slots.closeWorker(slot);
      throw new Error(`${slotName(slot)} window did not connect.`);
    }
    this.host.daemonLog(
      `agent_worker_opened: worker=${slotName(slot)} owner=${callerSlot ? slotName(callerSlot) : "external"} cwd=${cwd} visible=${visible}`,
    );
    await this.mirror(slot, t("agentBus.mirror.opened", { owner: callerSlot ? slotName(callerSlot) : t("agentBus.externalCaller") }));
    return this.summary(slot);
  }

  /** The owner closes a worker it opened. */
  close(params: { caller?: AgentRef; target: AgentRef }): { closed: boolean } {
    const slot = this.requireOwnedWorker(params.caller, params.target);
    this.host.daemonLog(`agent_worker_close: worker=${slotName(slot)}`);
    this.host.slotManager.closeWorker(slot);
    return { closed: true };
  }

  /** The owner starts a fresh session in an idle worker. */
  async newSession(params: { caller?: AgentRef; target: AgentRef }): Promise<AgentSummary> {
    const slot = this.requireOwnedWorker(params.caller, params.target);
    if (!this.isIdle(slot) || (this.queues.get(slot)?.length ?? 0) > 0) {
      throw new Error(`${slotName(slot)} is busy; wait for its calls to finish first.`);
    }
    await this.host.slotManager.startFreshSlotSession(slot);
    this.host.daemonLog(`agent_worker_new_session: worker=${slotName(slot)}`);
    return this.summary(slot);
  }

  async call(params: { caller?: AgentRef; target: AgentRef; text: string }): Promise<AgentCallView> {
    const text = params.text.trim();
    if (!text) throw new Error("agent_call requires non-empty text.");
    this.prune();
    const callerSlot = this.requireCaller(params.caller);
    const targetCwd = params.target.cwd || callerSlot?.cwd || this.host.slotManager.activeCwd;
    const targetSlot = this.findSlot({ ...params.target, cwd: targetCwd });
    if (!targetSlot) throw new Error(`Agent ${params.target.adapter} is not open in ${targetCwd}.`);
    if (callerSlot === targetSlot) throw new Error("An agent cannot call itself.");

    const parentId = callerSlot?.turns.activeTask?.agentCallId;
    const parent = parentId ? this.calls.get(parentId) : undefined;
    const chain = [...(parent?.chain ?? []), ...(callerSlot ? [agentKey(refOf(callerSlot))] : [])];
    const targetKey = agentKey(refOf(targetSlot));
    if (chain.includes(targetKey)) {
      throw new Error(`Calling ${slotName(targetSlot)} would loop back to an agent already waiting in this chain.`);
    }
    if (chain.length > MAX_CALL_DEPTH) throw new Error(`Agent calls may nest at most ${MAX_CALL_DEPTH} levels.`);
    const queue = this.queues.get(targetSlot) ?? [];
    if (queue.length >= MAX_QUEUED_CALLS) throw new Error(`${slotName(targetSlot)} already has ${queue.length} queued calls.`);

    const call: AgentCall = {
      callId: `call-${crypto.randomBytes(4).toString("hex")}`,
      ...(callerSlot ? { caller: refOf(callerSlot) } : {}),
      target: refOf(targetSlot),
      text,
      chain,
      status: "queued",
      createdAtMs: Date.now(),
      consumed: false,
      interruptRequested: false,
      waiters: [],
    };
    this.calls.set(call.callId, call);
    queue.push(call.callId);
    this.queues.set(targetSlot, queue);
    this.host.daemonLog(
      `agent_call_created: call=${call.callId} caller=${callerSlot ? slotName(callerSlot) : "external"} target=${slotName(targetSlot)} depth=${chain.length} text=${truncatePreview(text)}`,
    );
    await this.drain(targetSlot);
    return this.view(call);
  }

  get(params: { callId: string; consume?: boolean }): AgentCallView {
    const call = this.requireCall(params.callId);
    if (params.consume && SETTLED_STATUSES.has(call.status)) {
      call.consumed = true;
    }
    return this.view(call);
  }

  /** Wait until the call settles or needs a decision, at most `waitMs`. */
  async wait(params: { callId: string; waitMs?: number; consume?: boolean }): Promise<AgentCallView> {
    const call = this.requireCall(params.callId);
    const waitMs = Math.min(Math.max(params.waitMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS);
    if (!SETTLED_STATUSES.has(call.status) && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        call.waiters.push(done);
      });
    }
    return this.get({ callId: call.callId, consume: params.consume });
  }

  async interrupt(params: { callId: string }): Promise<AgentCallView> {
    const call = this.requireCall(params.callId);
    if (SETTLED_STATUSES.has(call.status)) return this.view(call);
    const slot = this.findSlot(call.target);
    if (call.status === "queued" || !slot) {
      if (slot) this.removeFromQueue(slot, call.callId);
      this.settle(call, "interrupted");
      return this.view(call);
    }
    call.interruptRequested = true;
    this.host.daemonLog(`agent_call_interrupt: call=${call.callId} target=${slotName(slot)}`);
    await slot.runtime.interrupt();
    return this.view(call);
  }

  /** The direct caller decides an approval its call's turn is waiting on. */
  async approve(params: {
    callId: string;
    caller: AgentRef;
    decision: AgentApprovalDecision;
    requestId?: string;
    reason?: string;
  }): Promise<{ resolved: boolean; call: AgentCallView }> {
    const call = this.requireCall(params.callId);
    const callerSlot = this.findSlot(params.caller);
    if (!call.caller || !callerSlot || agentKey(call.caller) !== agentKey(refOf(callerSlot))) {
      throw new Error("Only the agent that made this call can decide its approvals.");
    }
    if (!["confirm", "deny", "abort"].includes(params.decision)) {
      throw new Error(`Unsupported decision ${params.decision}; use confirm, deny, or abort.`);
    }
    const slot = this.findSlot(call.target);
    if (!slot || slot.turns.activeTask?.agentCallId !== call.callId || slot.pendingConfirmations.length === 0) {
      return { resolved: false, call: this.view(call) };
    }
    const live = slot.runtime.getState();
    const pending = (params.requestId !== undefined
      ? slot.pendingConfirmations.find((request) => request.requestId === params.requestId)
      : undefined) ?? slot.pendingConfirmations[0]!;
    if (params.requestId !== undefined && pending.requestId !== params.requestId) {
      return { resolved: false, call: this.view(call) };
    }
    if (params.decision === "confirm" && !pending.agentConfirmable) {
      throw new Error("Only the operator can confirm this high-risk approval; deny or abort it, or leave it to the operator.");
    }
    if (params.decision === "abort" && !pending.extraDecisions?.includes("abort")) {
      throw new Error(`${slot.adapter} cannot stop the turn from an approval; use deny.`);
    }
    const nativeReason = params.decision === "deny" && params.reason && pending.denyReasonSupported
      ? { reason: params.reason }
      : undefined;
    const resolved = await slot.runtime.resolveApproval(params.decision, pending.requestId, nativeReason);
    if (!resolved) return { resolved: false, call: this.view(call) };
    const adapterState = slot.runtime.getState();
    slot.pendingConfirmations = (adapterState.pendingApprovals ?? (adapterState.pendingApproval ? [adapterState.pendingApproval] : []))
      .map((request) => toPendingApproval({ type: "approval_required", request, timestamp: nowIso() }));
    if (params.decision === "abort") this.host.typing.stop(slot, "approval_abort");
    else this.host.typing.resume(slot);
    this.host.daemonLog(
      `agent_approval_resolved: call=${call.callId} caller=${slotName(callerSlot)} target=${slotName(slot)} decision=${params.decision} command=${truncatePreview(pending.commandPreview)} live_pending=${live.pendingApprovals?.length ?? (live.pendingApproval ? 1 : 0)}`,
    );
    await this.mirror(slot, t(`agentBus.mirror.approval.${params.decision}`, {
      caller: slotName(callerSlot),
      command: truncatePreview(pending.commandPreview, 120),
    }));
    return { resolved: true, call: this.view(call) };
  }

  onFinalReply(task: ActiveTask | null, text: string): void {
    const call = this.callOf(task);
    if (!call) return;
    call.reply = text;
  }

  /** A turn of the slot waits on an approval or a question. */
  onDecisionRequired(slot: DaemonSlot, task: ActiveTask | null, kind: "approval" | "user_input"): void {
    const call = this.callOf(task);
    if (!call) return;
    this.wake(call);
    if (kind !== "approval" || !call.caller) return;
    const callerSlot = this.findSlot(call.caller);
    const requestId = slot.runtime.getState().pendingApproval?.requestId;
    if (callerSlot) {
      this.enqueueDelivery(callerSlot, { callId: call.callId, kind: "approval", requestId });
    }
  }

  onTurnSettled(task: ActiveTask | null, failure?: string): void {
    const call = this.callOf(task);
    if (!call) return;
    if (call.interruptRequested) this.settle(call, "interrupted");
    else if (failure !== undefined) this.settle(call, "failed", failure);
    else this.settle(call, "completed");
  }

  onSlotRemoved(slot: DaemonSlot): void {
    // Workers end with the agent that opened them.
    const key = agentKey(refOf(slot));
    for (const worker of this.host.slotManager.workerSlots()) {
      if (worker.worker?.ownerKey === key) {
        this.host.daemonLog(`agent_worker_owner_closed: worker=${slotName(worker)} owner=${slotName(slot)}`);
        this.host.slotManager.closeWorker(worker);
      }
    }
    const activeCall = this.callOf(slot.turns.activeTask);
    if (activeCall) this.settle(activeCall, "failed", t("agentBus.error.targetClosed", { agent: slotName(slot) }));
    for (const callId of this.queues.get(slot) ?? []) {
      const call = this.calls.get(callId);
      if (call) this.settle(call, "failed", t("agentBus.error.targetClosed", { agent: slotName(slot) }));
    }
    this.queues.delete(slot);
    this.deliveries.delete(slot);
  }

  /** Start the slot's next queued call, or tell it a result, once it is idle. */
  async drain(slot: DaemonSlot): Promise<void> {
    if (this.draining.has(slot)) return;
    this.draining.add(slot);
    try {
      await this.host.slotManager.serializeSlotInput(slot, async () => {
        if (!this.isIdle(slot) || this.host.slotManager.getSlot(slot.cwd, slot.adapter, slot.instance) !== slot) return;
        const queue = this.queues.get(slot) ?? [];
        const nextCallId = queue[0];
        if (nextCallId) {
          queue.shift();
          const call = this.calls.get(nextCallId);
          if (call && call.status === "queued") await this.start(slot, call);
          return;
        }
        await this.deliverNext(slot);
      });
    } finally {
      this.draining.delete(slot);
    }
  }

  private async start(slot: DaemonSlot, call: AgentCall): Promise<void> {
    const callerName = this.callerName(call);
    const task: ActiveTask = {
      startedAt: Date.now(),
      inputPreview: truncatePreview(call.text, 180),
      agentCallId: call.callId,
    };
    try {
      const result = await slot.turns.dispatch({
        task,
        forward: async () => {
          this.host.daemonLog(`agent_call_started: call=${call.callId} target=${slotName(slot)}`);
          await slot.runtime.sendInput(t("agentBus.prompt.request", { caller: callerName, callId: call.callId, text: call.text }));
        },
      });
      if (result.status === "busy") {
        this.queues.get(slot)?.unshift(call.callId);
        return;
      }
    } catch (error) {
      this.settle(call, "failed", error instanceof Error ? error.message : String(error));
      return;
    }
    call.status = "running";
    call.startedAtMs = Date.now();
    this.host.typing.start(slot, this.host.operatorId);
    await this.mirror(slot, t("agentBus.mirror.request", { caller: callerName, text: call.text }));
  }

  private async deliverNext(slot: DaemonSlot): Promise<void> {
    const queue = this.deliveries.get(slot) ?? [];
    while (queue.length > 0) {
      const delivery = queue.shift()!;
      const call = this.calls.get(delivery.callId);
      if (!call) continue;
      const prompt = this.deliveryPrompt(call, delivery);
      if (!prompt) continue;
      const task: ActiveTask = {
        startedAt: Date.now(),
        inputPreview: truncatePreview(prompt, 180),
        agentCallback: delivery.callId,
      };
      try {
        const result = await slot.turns.dispatch({
          task,
          forward: async () => {
            this.host.daemonLog(`agent_call_delivered: call=${call.callId} kind=${delivery.kind} caller=${slotName(slot)}`);
            await slot.runtime.sendInput(prompt);
          },
        });
        if (result.status === "busy") {
          queue.unshift(delivery);
          return;
        }
      } catch (error) {
        this.host.daemonLog(`agent_call_delivery_failed: call=${call.callId} message=${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (delivery.kind === "result") call.consumed = true;
      this.host.typing.start(slot, this.host.operatorId);
      return;
    }
  }

  private deliveryPrompt(call: AgentCall, delivery: AgentDelivery): string | null {
    const target = slotName(call.target);
    if (delivery.kind === "approval") {
      const slot = this.findSlot(call.target);
      const pending = slot?.turns.activeTask?.agentCallId === call.callId
        ? slot.pendingConfirmations.find((request) => request.requestId === delivery.requestId) ?? slot.pendingConfirmations[0]
        : undefined;
      if (!pending) return null;
      return t(pending.agentConfirmable ? "agentBus.prompt.approval" : "agentBus.prompt.approvalOperatorOnly", {
        target,
        callId: call.callId,
        summary: pending.summary,
        command: pending.commandPreview,
      });
    }
    if (call.consumed) return null;
    if (call.status === "completed") {
      return t("agentBus.prompt.completed", { target, callId: call.callId, reply: call.reply?.trim() || t("agentBus.prompt.emptyReply") });
    }
    if (call.status === "interrupted") return t("agentBus.prompt.interrupted", { target, callId: call.callId });
    return t("agentBus.prompt.failed", { target, callId: call.callId, error: call.error ?? "" });
  }

  private settle(call: AgentCall, status: AgentCallStatus, error?: string): void {
    if (SETTLED_STATUSES.has(call.status)) return;
    call.status = status;
    if (error !== undefined) call.error = error;
    call.endedAtMs = Date.now();
    this.host.daemonLog(`agent_call_settled: call=${call.callId} status=${status}${error ? ` error=${truncatePreview(error)}` : ""}`);
    this.wake(call);
    const callerSlot = call.caller ? this.findSlot(call.caller) : undefined;
    if (callerSlot) {
      this.enqueueDelivery(callerSlot, { callId: call.callId, kind: "result" });
    }
  }

  private enqueueDelivery(slot: DaemonSlot, delivery: AgentDelivery): void {
    const queue = this.deliveries.get(slot) ?? [];
    queue.push(delivery);
    this.deliveries.set(slot, queue);
    // Events settle calls synchronously; deliver once the current turn
    // bookkeeping has finished.
    setTimeout(() => void this.drain(slot), 0);
  }

  private wake(call: AgentCall): void {
    const waiters = call.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private view(call: AgentCall): AgentCallView {
    const slot = this.findSlot(call.target);
    let status = call.status;
    let pendingApproval: AgentCallView["pendingApproval"];
    let pendingUserInput: AgentCallView["pendingUserInput"];
    if (status === "running" && slot && slot.turns.activeTask?.agentCallId === call.callId) {
      const approval = slot.pendingConfirmations[0];
      if (approval) {
        status = "awaiting_approval";
        pendingApproval = {
          requestId: approval.requestId,
          summary: approval.summary,
          commandPreview: approval.commandPreview,
          callerMayConfirm: approval.agentConfirmable === true,
        };
      } else if (slot.pendingUserInput) {
        status = "awaiting_input";
        pendingUserInput = { summary: slot.pendingUserInput.summary };
      }
    }
    const queuePosition = status === "queued" && slot ? (this.queues.get(slot)?.indexOf(call.callId) ?? -1) + 1 : 0;
    return {
      callId: call.callId,
      status,
      ...(call.caller ? { caller: slotName(call.caller) } : {}),
      target: slotName(call.target),
      targetCwd: call.target.cwd,
      createdAt: new Date(call.createdAtMs).toISOString(),
      ...(call.startedAtMs ? { startedAt: new Date(call.startedAtMs).toISOString() } : {}),
      ...(call.endedAtMs ? { endedAt: new Date(call.endedAtMs).toISOString() } : {}),
      ...(queuePosition > 0 ? { queuePosition } : {}),
      ...(call.reply !== undefined && SETTLED_STATUSES.has(call.status) ? { reply: call.reply } : {}),
      ...(call.error !== undefined ? { error: call.error } : {}),
      ...(pendingApproval ? { pendingApproval } : {}),
      ...(pendingUserInput ? { pendingUserInput } : {}),
    };
  }

  private isIdle(slot: DaemonSlot): boolean {
    const state = slot.runtime.getState();
    return !slot.turns.hasActiveTask &&
      slot.pendingConfirmations.length === 0 &&
      !slot.pendingUserInput &&
      slot.deferredInputs.length === 0 &&
      !state.activeTurnId &&
      !BUSY_STATUSES.has(state.status);
  }

  private summary(slot: DaemonSlot): AgentSummary {
    return {
      name: slotName(slot),
      adapter: slot.adapter,
      instance: slot.instance,
      cwd: slot.cwd,
      status: slot.runtime.getState().status,
      idle: this.isIdle(slot),
      queuedCalls: this.queues.get(slot)?.length ?? 0,
      ...(slot.turns.activeTask?.agentCallId ? { activeCallId: slot.turns.activeTask.agentCallId } : {}),
      ...(slot.worker ? { worker: slot.worker.ownerName ? { owner: slot.worker.ownerName } : {} } : {}),
    };
  }

  private requireCaller(ref: AgentRef | undefined): DaemonSlot | undefined {
    if (!ref) return undefined;
    const slot = this.findSlot(ref);
    if (!slot) throw new Error(`Calling agent ${ref.name ?? ref.adapter} is not open in ${ref.cwd}.`);
    return slot;
  }

  private requireOwnedWorker(callerRef: AgentRef | undefined, target: AgentRef): DaemonSlot {
    const callerSlot = this.requireCaller(callerRef);
    const slot = this.findSlot(target);
    if (!slot?.worker) throw new Error(`${target.name ?? target.adapter} is not a worker opened by an agent.`);
    const callerKey = callerSlot ? agentKey(refOf(callerSlot)) : undefined;
    if (slot.worker.ownerKey !== callerKey) {
      throw new Error(`Only the agent that opened ${slotName(slot)} can close it or restart its session.`);
    }
    return slot;
  }

  private findSlot(ref: AgentRef): DaemonSlot | undefined {
    const slots = this.host.slotManager;
    if (ref.name) {
      return slots.everySlot().find((slot) => slotName(slot) === ref.name && isSameWorkspace(slot.cwd, ref.cwd));
    }
    if (ref.instance !== undefined) return slots.getSlot(ref.cwd, ref.adapter, ref.instance);
    return slots.allSlots().find((slot) => slot.adapter === ref.adapter && isSameWorkspace(slot.cwd, ref.cwd) && slot.instance === 1)
      ?? slots.getSlot(ref.cwd, ref.adapter);
  }

  private callOf(task: ActiveTask | null): AgentCall | undefined {
    return task?.agentCallId ? this.calls.get(task.agentCallId) : undefined;
  }

  private callerName(call: AgentCall): string {
    return call.caller ? slotName(call.caller) : t("agentBus.externalCaller");
  }

  private requireCall(callId: string): AgentCall {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Unknown agent call ${callId}.`);
    return call;
  }

  private removeFromQueue(slot: DaemonSlot, callId: string): void {
    const queue = this.queues.get(slot);
    if (!queue) return;
    const index = queue.indexOf(callId);
    if (index >= 0) queue.splice(index, 1);
  }

  private mirror(slot: DaemonSlot, text: string): Promise<boolean> {
    return this.host.queueMessage(this.host.operatorId, this.host.slotManager.prefix(slot, text), "notice");
  }

  private prune(): void {
    const cutoff = Date.now() - SETTLED_RETENTION_MS;
    for (const [callId, call] of this.calls) {
      if (call.endedAtMs !== undefined && call.endedAtMs < cutoff) this.calls.delete(callId);
    }
  }
}
