// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type {
  BridgeAdapterKind,
  BridgeTurnOrigin,
  BridgeWorkerStatus,
} from "../bridge/bridge-types.ts";

export function shouldDeferCodexInboundMessage(params: {
  adapter: BridgeAdapterKind;
  status: BridgeWorkerStatus;
  activeTurnOrigin?: BridgeTurnOrigin;
  hasPendingConfirmation: boolean;
  hasSystemCommand: boolean;
}): boolean {
  return (
    params.adapter === "codex" &&
    !params.hasPendingConfirmation &&
    !params.hasSystemCommand &&
    params.activeTurnOrigin === "local" &&
    (params.status === "busy" || params.status === "awaiting_approval")
  );
}

export function canDrainDeferredCodexInboundQueue(params: {
  adapter: BridgeAdapterKind;
  deferredCount: number;
  status: BridgeWorkerStatus;
  activeTurnId?: string;
  hasPendingConfirmation: boolean;
  hasPendingUserInput: boolean;
  hasPendingApproval: boolean;
  hasActiveTask: boolean;
}): boolean {
  return (
    params.adapter === "codex" &&
    params.deferredCount > 0 &&
    !params.hasPendingConfirmation &&
    !params.hasPendingUserInput &&
    !params.hasPendingApproval &&
    !params.hasActiveTask &&
    !params.activeTurnId &&
    params.status !== "busy" &&
    params.status !== "awaiting_approval" &&
    params.status !== "awaiting_input"
  );
}

export function formatDeferredCodexInboundQueueMessage(queuePosition: number): string {
  return `Queued for delivery after the current local Codex turn finishes. Queue position: ${queuePosition}.`;
}

export function isRetryableDeferredCodexDrainError(errorText: string): boolean {
  return /still working|approval request is pending|waiting for local terminal input/i.test(
    errorText,
  );
}
