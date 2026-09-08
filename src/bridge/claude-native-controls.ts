import type { BridgeModelOption } from "./bridge-types.ts";
import { NativeTerminalControl, parseClaudeModelPicker, readClaudePermissionMode } from "./native-terminal-control.ts";

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
      throw new Error("Claude must be at an empty native prompt before changing models or plan mode.");
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
        if (!focused) throw new Error("Could not identify the focused Claude model. Close the menu and try again.");
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
        if (!focused) throw new Error("Could not identify the focused Claude model.");
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
    if (!Number.isSafeInteger(target.index) || target.index < 1 || typeof target.label !== "string") throw new Error("Invalid Claude model selection. Send /model again.");
    return this.terminal.run(async () => {
      this.assertPrompt();
      await this.terminal.openMenu("/model", "Select model");
      const visited = new Set<number>();
      while (true) {
        const focused = parseClaudeModelPicker(this.terminal.text).find((row) => row.focused);
        if (!focused) throw new Error("Could not identify the focused Claude model.");
        if (focused.index === target.index) {
          if (focused.label !== target.label) throw new Error("The Claude model list changed. Send /model again.");
          break;
        }
        if (visited.has(focused.index)) throw new Error("The Claude model is no longer selectable. Send /model again.");
        visited.add(focused.index);
        await this.terminal.key(focused.index < target.index ? "\u001b[B" : "\u001b[A");
      }
      if (!/s to use this session only/i.test(this.terminal.text)) {
        throw new Error("This Claude version does not expose session-only model selection. Update Claude Code and try again.");
      }
      await this.terminal.submitMenu(undefined, "s");
      await this.terminal.waitFor(() => readClaudePermissionMode(this.terminal.text) !== null);
      await this.terminal.openMenu("/model", "Select model");
      const applied = parseClaudeModelPicker(this.terminal.text).find((row) => row.focused);
      if (!applied || applied.label !== target.label || applied.index !== target.index) throw new Error("Claude did not confirm the selected model.");
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
          throw new Error(`Claude cannot restore permission mode ${current} through the native mode switch.`);
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
        if (!mode || visited.has(mode)) throw new Error(`Claude could not restore ${target}; check the native permission mode.`);
        visited.add(mode);
        await this.terminal.key("\u001b[Z");
        await this.terminal.waitFor(() => readClaudePermissionMode(this.terminal.text) !== mode);
      }
      this.previousMode = null;
      return false;
    });
  }
}
