// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { DaemonAdapterKind } from "./daemon-link.ts";
import { isSameWorkspace } from "./daemon-slot.ts";

/**
 * How much of the multi-bridge surface the daemon exposes. A bridge starts
 * clean (`single`) and only ever moves up, until the daemon exits:
 * - `single` (L0): one window; no addressing, no prefix.
 * - `multi_type` (L1): several CLI types in the anchor workspace, one each.
 * - `multi_instance` (L2): several windows of one CLI type in the anchor
 *   workspace, addressed by number.
 * - `multi_workspace` (L3): no limits; workspace, CLI type, and number.
 * L1 and L2 never mix; a window in another workspace leads to L3.
 */
export type BridgeMode =
  | { kind: "none" }
  | { kind: "single"; anchorCwd: string; adapter: DaemonAdapterKind }
  | { kind: "multi_type"; anchorCwd: string }
  | { kind: "multi_instance"; anchorCwd: string; adapter: DaemonAdapterKind }
  | { kind: "multi_workspace" };

export type BridgeModeKind = BridgeMode["kind"];

/** A window (slot) the bridge already holds. */
export type BridgeWindow = {
  cwd: string;
  adapter: DaemonAdapterKind;
  instance: number;
};

export type WindowRefusal =
  /** L1: this workspace already runs this CLI type. */
  | "type_already_open"
  /** L2: only the locked CLI type may open more windows. */
  | "instance_mode_type_locked";

export type WindowAdmission =
  | {
    admitted: true;
    mode: BridgeMode;
    /** Instance number of the new window within its workspace and type. */
    instance: number;
    /** Set when admitting the window moved the bridge up a level. */
    upgradedTo?: Exclude<BridgeModeKind, "none" | "single">;
  }
  | { admitted: false; reason: WindowRefusal };

export const NO_BRIDGE_MODE: BridgeMode = { kind: "none" };

/** Lowest free instance number of a CLI type in a workspace; gaps are reused. */
export function nextInstance(
  windows: readonly BridgeWindow[],
  cwd: string,
  adapter: DaemonAdapterKind,
): number {
  const taken = new Set(
    windows
      .filter((window) => window.adapter === adapter && isSameWorkspace(window.cwd, cwd))
      .map((window) => window.instance),
  );
  let instance = 1;
  while (taken.has(instance)) {
    instance += 1;
  }
  return instance;
}

/**
 * Decide whether a new window (local launcher, Codex attach, or a remote
 * open) may join the bridge, and which mode the bridge is in afterwards.
 */
export function admitWindow(
  mode: BridgeMode,
  windows: readonly BridgeWindow[],
  request: { cwd: string; adapter: DaemonAdapterKind },
): WindowAdmission {
  const instance = nextInstance(windows, request.cwd, request.adapter);
  const admit = (next: BridgeMode, upgraded: boolean): WindowAdmission => ({
    admitted: true,
    mode: next,
    instance,
    ...(upgraded && next.kind !== "none" && next.kind !== "single"
      ? { upgradedTo: next.kind }
      : {}),
  });

  switch (mode.kind) {
    case "none":
      return admit({ kind: "single", anchorCwd: request.cwd, adapter: request.adapter }, false);
    case "multi_workspace":
      return admit(mode, false);
    default:
      break;
  }

  if (!isSameWorkspace(request.cwd, mode.anchorCwd)) {
    return admit({ kind: "multi_workspace" }, true);
  }

  switch (mode.kind) {
    case "single":
      return request.adapter === mode.adapter
        ? admit({ kind: "multi_instance", anchorCwd: mode.anchorCwd, adapter: mode.adapter }, true)
        : admit({ kind: "multi_type", anchorCwd: mode.anchorCwd }, true);
    case "multi_type":
      return instance > 1
        ? { admitted: false, reason: "type_already_open" }
        : admit(mode, false);
    case "multi_instance":
      return request.adapter === mode.adapter
        ? admit(mode, false)
        : { admitted: false, reason: "instance_mode_type_locked" };
  }
}

/**
 * Mode once a window closed. Modes never step down while the daemon runs;
 * only a resident daemon whose last window closed starts over.
 */
export function modeAfterWindowClosed(
  mode: BridgeMode,
  remainingWindows: number,
  resident: boolean,
): BridgeMode {
  return resident && remainingWindows === 0 ? NO_BRIDGE_MODE : mode;
}

export type ModeCommand = "cd" | "all" | "instance" | "open";

/** Channel commands each mode exposes beyond the single-CLI set. */
export function modeAllowsCommand(mode: BridgeMode, command: ModeCommand): boolean {
  switch (command) {
    case "cd":
      return mode.kind === "multi_workspace";
    case "all":
      return mode.kind === "multi_type" || mode.kind === "multi_instance" ||
        mode.kind === "multi_workspace";
    case "instance":
      return mode.kind === "multi_instance" || mode.kind === "multi_workspace";
    case "open":
      return mode.kind === "single" || mode.kind === "multi_instance" ||
        mode.kind === "multi_workspace";
  }
}

/**
 * How a window is named to the operator, or `null` when replies carry no
 * prefix: `codex` (L1), `pi-1` (L2), `my-app/codex` or `my-app/pi-2` (L3,
 * numbered once the workspace runs that type more than once).
 */
export function windowSourceName(
  mode: BridgeMode,
  window: BridgeWindow,
  windows: readonly BridgeWindow[],
  workspaceLabel: (cwd: string) => string,
): string | null {
  switch (mode.kind) {
    case "none":
    case "single":
      return null;
    case "multi_type":
      return window.adapter;
    case "multi_instance":
      return `${window.adapter}-${window.instance}`;
    case "multi_workspace": {
      const numbered = window.instance > 1 || windows.some((other) =>
        other !== window &&
        other.adapter === window.adapter &&
        other.instance !== window.instance &&
        isSameWorkspace(other.cwd, window.cwd));
      const name = numbered ? `${window.adapter}-${window.instance}` : window.adapter;
      return `${workspaceLabel(window.cwd)}/${name}`;
    }
  }
}
