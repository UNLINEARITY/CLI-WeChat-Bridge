// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../i18n/index.ts";
import type { BridgeModelOption } from "./bridge-types.ts";
import { NativeTerminalControl, parseClaudeModelPicker, parseClaudeModelSwitchConfirmation, readClaudePermissionMode } from "./native-terminal-control.ts";

export class ClaudeNativeControls {
  private previousMode: { session: string; mode: string } | null = null;

  private readonly terminal: NativeTerminalControl;
  private readonly session: () => string;
  constructor(terminal: NativeTerminalControl, session: () => string) {
    this.terminal = terminal;
    this.session = session;
  }

  private assertPrompt(): void {
    if (readClaudePermissionMode(this.terminal.text) === null) {
      throw new Error(t("native.claude.emptyPrompt"));
    }
  }

  async listModels(): Promise<BridgeModelOption[]> {
    return this.terminal.run(async () => {
      this.assertPrompt();
      await this.terminal.openMenu("/model", "Select model");
      const options = new Map<number, BridgeModelOption>();
      const visited = new Set<number>();
      const initial = parseClaudeModelPicker(this.terminal.text).find((option) => option.focused)?.index;
      while (true) {
        const rows = parseClaudeModelPicker(this.terminal.text);
        for (const row of rows) {
          options.set(row.index, {
            id: JSON.stringify({ index: row.index, label: row.label }),
            displayName: row.label,
            isCurrent: row.current || row.index === initial,
          });
        }
        const focused = rows.find((row) => row.focused);
        if (!focused) throw new Error(t("native.claude.focusClose"));
        if (visited.has(focused.index)) break;
        visited.add(focused.index);
        await this.terminal.key("\u001b[B");
      }
      // A clamped selector can start in the middle; walk upwards to capture earlier hidden rows too.
      const visitedUp = new Set<number>();
      while (true) {
        const rows = parseClaudeModelPicker(this.terminal.text);
        for (const row of rows) {
          options.set(row.index, { id: JSON.stringify({ index: row.index, label: row.label }), displayName: row.label, isCurrent: row.current || row.index === initial });
        }
        const focused = rows.find((row) => row.focused);
        if (!focused) throw new Error(t("native.claude.focus"));
        if (visitedUp.has(focused.index)) break;
        visitedUp.add(focused.index);
        if (focused.index === 1) break;
        await this.terminal.key("\u001b[A");
      }
      await this.terminal.closeMenu();
      return [...options.entries()].filter(([index]) => visited.has(index) || visitedUp.has(index)).sort(([a], [b]) => a - b).map(([, option]) => option);
    });
  }

  async selectModel(id: string): Promise<BridgeModelOption> {
    const target = JSON.parse(id) as { index: number; label: string };
    if (!Number.isSafeInteger(target.index) || target.index < 1 || typeof target.label !== "string") throw new Error(t("native.claude.invalidModel"));
    return this.terminal.run(async () => {
      this.assertPrompt();
      await this.terminal.openMenu("/model", "Select model");
      const visited = new Set<number>();
      while (true) {
        const focused = parseClaudeModelPicker(this.terminal.text).find((row) => row.focused);
        if (!focused) throw new Error(t("native.claude.focus"));
        if (focused.index === target.index) {
          if (focused.label !== target.label) throw new Error(t("native.claude.changed"));
          break;
        }
        if (visited.has(focused.index)) throw new Error(t("native.claude.unavailable"));
        visited.add(focused.index);
        await this.terminal.key(focused.index < target.index ? "\u001b[B" : "\u001b[A");
      }
      if (!/s to use this session only/i.test(this.terminal.text)) {
        throw new Error(t("native.claude.update"));
      }
      await this.terminal.submitMenu(undefined, "s");
      await this.terminal.waitFor(() => parseClaudeModelSwitchConfirmation(this.terminal.text) !== null || readClaudePermissionMode(this.terminal.text) !== null);
      const confirmation = parseClaudeModelSwitchConfirmation(this.terminal.text);
      if (confirmation) {
        const targetLabel = target.label.toLowerCase();
        const confirmedModel = confirmation.model.toLowerCase();
        const matchesTarget = targetLabel.includes(confirmedModel)
          || (targetLabel.startsWith("default (recommended)") && confirmedModel.endsWith(" (default)"));
        if (!confirmation.yesFocused || !matchesTarget) {
          throw new Error(t("native.claude.confirmation"));
        }
        await this.terminal.key("\r");
        await this.terminal.waitFor(() => readClaudePermissionMode(this.terminal.text) !== null);
      }
      await this.terminal.openMenu("/model", "Select model");
      const applied = parseClaudeModelPicker(this.terminal.text).find((row) => row.focused);
      if (!applied || applied.label !== target.label || applied.index !== target.index) throw new Error(t("native.claude.notConfirmed"));
      await this.terminal.closeMenu();
      return { id, displayName: target.label, isCurrent: true };
    });
  }

  async setPlanMode(enabled: boolean): Promise<boolean> {
    return this.terminal.run(async () => {
      this.assertPrompt();
      const current = readClaudePermissionMode(this.terminal.text)!;
      const session = this.session();
      if (this.previousMode?.session !== session) this.previousMode = null;
      if (enabled) {
        if (current === "plan") return true;
        if (!["default", "acceptEdits", "bypassPermissions", "auto"].includes(current)) {
          throw new Error(t("native.claude.restoreUnsupported", { mode: current }));
        }
        await this.terminal.command("/plan");
        await this.terminal.waitFor(() => readClaudePermissionMode(this.terminal.text) === "plan");
        this.previousMode = { session, mode: current };
        return true;
      }
      if (current !== "plan") { this.previousMode = null; return false; }
      const target = this.previousMode?.mode ?? "default";
      const visited = new Set<string>();
      while (true) {
        const mode = readClaudePermissionMode(this.terminal.text);
        if (mode === target) break;
        if (!mode || visited.has(mode)) throw new Error(t("native.claude.restoreFailed", { mode: target }));
        visited.add(mode);
        await this.terminal.key("\u001b[Z");
        await this.terminal.waitFor(() => readClaudePermissionMode(this.terminal.text) !== mode);
      }
      this.previousMode = null;
      return false;
    });
  }
}
