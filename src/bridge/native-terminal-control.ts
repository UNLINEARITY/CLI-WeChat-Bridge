import xterm from "@xterm/headless";

const { Terminal } = xterm;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A screen mirror, never a second input source: only explicit control operations write keys. */
export class NativeTerminalControl {
  private terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 0, logLevel: "off" });
  private writes = Promise.resolve();
  private lastFrameAt = 0;
  private operation: { identity: string; deadline: number; error?: Error } | null = null;
  private ownedMenu: string | null = null;
  private draft = false;
  private inputSequence = "";
  private inputEscapeTimer: ReturnType<typeof setTimeout> | undefined;
  private pasting = false;

  private readonly options: {
    write: (text: string) => void;
    identity: () => string;
    assertReady: () => void;
    isPromptEmpty?: () => boolean;
    prepare?: () => Promise<void>;
  };

  constructor(options: NativeTerminalControl["options"]) { this.options = options; }

  get active(): boolean { return this.operation !== null; }

  feed(text: string): void {
    this.writes = this.writes.then(() => new Promise<void>((resolve) => this.terminal.write(text, () => {
      this.lastFrameAt = Date.now();
      resolve();
    })));
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(20, cols), Math.max(8, rows));
  }

  localInput(text: string): void {
    // stdin also carries terminal replies (colors, capabilities, cursor position).
    // Parse across chunks before deciding that anything came from the keyboard.
    // The adapter still forwards every original byte to the child PTY unchanged.
    for (const char of text) {
      clearTimeout(this.inputEscapeTimer);
      if (!this.inputSequence) {
        if (char !== "\u001b") { this.keyboardInput(char); continue; }
        this.inputSequence = char;
        // A lone Escape is a key; a following introducer belongs to a sequence.
        this.inputEscapeTimer = setTimeout(() => {
          this.inputSequence = "";
          this.keyboardInput("\u001b");
        }, 50);
        this.inputEscapeTimer.unref?.();
        continue;
      }
      this.inputSequence += char;
      const sequence = this.inputSequence;
      if (sequence.length === 2 && "[]P_^XO".includes(char)) continue;
      const kind = sequence[1];
      if (kind === "[" && !/[@-~]/.test(char)) continue;
      if (kind && "]P_^X".includes(kind) && char !== "\u0007" && !sequence.endsWith("\u001b\\")) {
        // Bound malformed control strings without treating their payload as text.
        if (sequence.length > 65_536) this.inputSequence = sequence.slice(0, 2);
        continue;
      }
      this.inputSequence = "";
      if (kind && "]P_^X".includes(kind)) continue;
      if (kind === "[") {
        const body = sequence.slice(2);
        if (body === "200~" || body === "201~") {
          this.pasting = body === "200~";
          this.keyboardInput("");
          continue;
        }
        // Device/status/window reports, Kitty capability replies and focus events.
        if (/^(?:[?>]?[\d;]*c|\??\d+;\d+R|[\d;]+[nt]|\??[\d;]+\$y|\?[\d;]+u|[IO])$/.test(body)) continue;
        // Printable keys in Kitty's extended keyboard protocol are still drafts.
        const key = /^(\d+)(?::[\d:]*)?(?:;([\d:;]+))?u$/.exec(body);
        if (key) {
          const code = Number(key[1]);
          const modifiers = key[2]?.split(";")[0] ?? "1";
          if (modifiers.endsWith(":3")) continue; // Key release.
          if (code === 13 && modifiers === "1") this.keyboardInput("\r");
          else if (code >= 32 && code < 57344) this.keyboardInput("x");
          else this.keyboardInput("");
        } else this.keyboardInput(""); // Navigation and mouse input cancel controls.
        continue;
      }
      this.keyboardInput(kind === "O" ? "" : char);
    }
  }

  private keyboardInput(char: string): void {
    this.cancel("The local keyboard interrupted the remote control operation.");
    if (!this.pasting && ["\r", "\n", "\u0003", "\u0015"].includes(char)) this.draft = false;
    else if (char && (char >= " " && char !== "\u007f" || this.pasting)) this.draft = true;
  }

  cancel(message: string): void {
    if (this.operation) this.operation.error = new Error(message);
  }

  async flush(): Promise<void> { await this.writes; }

  get lines(): string[] {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }

  get text(): string { return this.lines.join("\n"); }

  private check(): void {
    const operation = this.operation;
    if (!operation) throw new Error("No terminal control operation is active.");
    if (operation.error) throw operation.error;
    if (operation.identity !== this.options.identity()) {
      operation.error = new Error("The active CLI session changed during control. Try again.");
      throw operation.error;
    }
    this.options.assertReady();
    if (Date.now() > operation.deadline) throw new Error("Native CLI control timed out; the result could not be confirmed.");
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.operation) throw new Error("Another CLI control operation is in progress.");
    this.options.assertReady();
    this.operation = { identity: this.options.identity(), deadline: Date.now() + 25_000 };
    try {
      await this.flush();
      if (this.options.prepare) {
        await this.options.prepare();
        this.check();
        this.draft = false; // The native input state is authoritative when available.
      } else if (this.draft && this.options.isPromptEmpty?.()) this.draft = false;
      if (this.draft) throw new Error("The local terminal has an input draft. Submit or clear it before using remote controls.");
      const result = await action();
      this.check();
      return result;
    } finally {
      const operation = this.operation;
      let ready = false;
      try { this.options.assertReady(); ready = true; } catch { /* A task or approval may have taken over. */ }
      // Never send an Escape into a different session or after local input has taken over.
      if (ready && this.ownedMenu && !operation?.error && operation?.identity === this.options.identity() && this.hasMenu(this.ownedMenu)) {
        this.options.write("\u001b");
        await pause(100);
      }
      this.ownedMenu = null;
      this.operation = null;
    }
  }

  async key(text: string): Promise<void> {
    this.check();
    this.options.write(text);
    await pause(100);
    await this.flush();
    this.check();
  }

  async waitFor(predicate: () => boolean): Promise<void> {
    while (true) {
      this.check();
      await this.flush();
      if (predicate()) return;
      await pause(50);
    }
  }

  async command(command: string): Promise<void> {
    if (!/^\/[a-z]+$/.test(command)) throw new Error("Invalid native control command.");
    await this.key(`\u001b[200~${command}\u001b[201~`);
    await this.key("\r");
    // Claude can consume the first Enter to accept a slash completion while its
    // interactive UI is finishing startup. Retry only while that exact command
    // remains at the *last* prompt; never submit an arbitrary draft or a dialog.
    for (let retry = 0; retry < 3; retry++) {
      // A lazy-loaded command can briefly leave its autocomplete on screen.
      // Let the initial render complete before deciding whether Enter was consumed.
      const until = Date.now() + 1_500;
      do {
        await pause(100);
        await this.flush();
        this.check();
      } while (Date.now() < until && Date.now() - this.lastFrameAt < 500);
      if (Date.now() - this.lastFrameAt < 500) break;
      const prompt = this.lines.findLast((line) => /^\s*❯/.test(line))?.trim();
      if (prompt?.replace(/^❯\s*/, "").trim() !== command || /Select model|Select agent|Select variant/.test(this.text)) break;
      await this.key("\r");
    }
  }

  hasMenu(title: string): boolean {
    return this.lines.some((line) => line.trim() === title || new RegExp(`^${title}\\s+esc$`, "i").test(line.trim()));
  }

  async openMenu(command: string, title: string): Promise<void> {
    if (this.ownedMenu || /Select model|Select agent|Select variant/.test(this.text)) {
      throw new Error("A native CLI menu is already open. Close it before using remote controls.");
    }
    await this.command(command);
    await this.waitFor(() => this.hasMenu(title));
    this.ownedMenu = title;
  }

  async closeMenu(): Promise<void> {
    const title = this.ownedMenu;
    if (!title || !this.hasMenu(title)) throw new Error("The native selector changed unexpectedly.");
    await this.key("\u001b");
    await this.waitFor(() => !this.hasMenu(title));
    this.ownedMenu = null;
  }

  async submitMenu(nextTitle?: string, key = "\r"): Promise<void> {
    const title = this.ownedMenu;
    if (!title || !this.hasMenu(title)) throw new Error("The native selector changed unexpectedly.");
    await this.key(key);
    await this.waitFor(() => !this.hasMenu(title));
    this.ownedMenu = nextTitle && this.hasMenu(nextTitle) ? nextTitle : null;
  }

}

export type ClaudePickerOption = { index: number; label: string; current: boolean; focused: boolean };

export function parseClaudeModelPicker(text: string): ClaudePickerOption[] {
  const start = text.lastIndexOf("Select model");
  if (start < 0) return [];
  return text.slice(start).split("\n").flatMap((line) => {
    const match = /^\s*([❯>↑↓ ]*)\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    return [{ index: Number(match[2]), label: match[3]!.replace(/[✓✔]/g, "").replace(/\s+/g, " ").trim(), current: /[✓✔]/.test(line), focused: /[❯>]/.test(match[1]!) }];
  });
}

export function readClaudePermissionMode(text: string): string | null {
  const lines = text.split("\n");
  const prompt = lines.findLastIndex((line) => /^\s*❯/.test(line));
  if (prompt < 0 || !/^\s*❯\s*$/.test(lines[prompt]!)) return null;
  const footer = lines.slice(prompt + 1).join("\n");
  for (const [label, mode] of [["plan mode", "plan"], ["accept edits", "acceptEdits"], ["bypass permissions", "bypassPermissions"], ["auto", "auto"], ["don't ask", "dontAsk"]]) {
    if (footer.includes(`${label} on`)) return mode!;
  }
  return "default";
}
