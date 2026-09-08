import { describe, expect, test } from "bun:test";
import { ClaudeNativeControls } from "../../src/bridge/claude-native-controls.ts";
import { NativeTerminalControl, parseClaudeModelPicker, readClaudePermissionMode } from "../../src/bridge/native-terminal-control.ts";

// Layout captured from Claude Code 2.1.235; model names are deliberately neutral.
const claudeMenu = [
  "  Select model",
  "  Switch between Claude models.", "",
  "    1. Default (recommended)  Use the default model (currently custom-model)",
  "    2. Custom model           Custom Opus model (1M context)",
  "  ❯ 3. Custom model ✔         Custom Sonnet model (1M context)", "",
  "  Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

function mirror(write: (text: string) => void = () => {}, identity: () => string = () => "session") {
  return new NativeTerminalControl({ write, identity, assertReady: () => {} });
}
function draw(terminal: NativeTerminalControl, text: string) {
  terminal.feed(`\u001b[2J\u001b[H${text.replace(/\n/g, "\r\n")}`);
}

describe("native terminal screen and command ownership", () => {
  test("assembles split ANSI updates and distinguishes same-name Claude aliases", async () => {
    const terminal = mirror();
    terminal.feed("\u001b[");
    terminal.feed(`2J\u001b[H${claudeMenu.replace(/\n/g, "\r\n")}`);
    await terminal.flush();
    const options = parseClaudeModelPicker(terminal.text);
    expect(options).toHaveLength(3);
    expect(options[1]?.label).toBe("Custom model Custom Opus model (1M context)");
    expect(options[2]).toEqual({ index: 3, label: "Custom model Custom Sonnet model (1M context)", current: true, focused: true });
    terminal.feed("\u001b[2J\u001b[H❯ \r\nplan mode on");
    await terminal.flush();
    expect(parseClaudeModelPicker(terminal.text)).toEqual([]);
    expect(readClaudePermissionMode(terminal.text)).toBe("plan");
  });

  test("reads permission mode only at an empty prompt and from its footer", () => {
    expect(readClaudePermissionMode("old plan mode on\n❯\n────────\n")).toBe("default");
    expect(readClaudePermissionMode("❯ draft\nplan mode on")).toBeNull();
    expect(readClaudePermissionMode("❯\n⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe("bypassPermissions");
  });

  test("native input state takes precedence over screen layout and stale key tracking", async () => {
    let draft = false;
    const terminal = new NativeTerminalControl({ write: () => {}, identity: () => "session", assertReady: () => {}, prepare: async () => {
      if (draft) throw new Error("real local draft");
    } });
    terminal.localInput("stale input");
    draw(terminal, "Ask anything... placeholder\nSession title ends in esc");
    expect(await terminal.run(async () => "ready")).toBe("ready");
    draft = true;
    await expect(terminal.run(async () => true)).rejects.toThrow("real local draft");
  });

  test("allows controls after a locally typed draft has been visibly cleared", async () => {
    const terminal = new NativeTerminalControl({ write: () => {}, identity: () => "session", assertReady: () => {}, isPromptEmpty: () => readClaudePermissionMode(terminal.text) !== null });
    terminal.localInput("draft");
    draw(terminal, "❯\n");
    expect(await terminal.run(async () => "ready")).toBe("ready");
  });

  test("does not inject controls over a local draft", async () => {
    const keys: string[] = [];
    const terminal = mirror((key) => keys.push(key));
    terminal.localInput("unfinished task");
    await expect(terminal.run(() => terminal.key("\r"))).rejects.toThrow("input draft");
    expect(keys).toEqual([]);
  });

  test("terminal replies, including fragmented OSC and DCS, neither create drafts nor interrupt controls", async () => {
    const terminal = mirror();
    const replies = [
      "\u001b]11;rgb:0c0c/0c0c/0c0c\u001b\\",
      "\u001b]10;rgb:ffff/ffff/ffff\u0007",
      "\u001bP>|Windows Terminal(1.25)\u001b\\",
      "\u001b[?1;2c", "\u001b[>0;10;1c", "\u001b[40;1R", "\u001b[8;40;120t",
      "\u001b[?2026;2$y", "\u001b[?1u", "\u001b[I", "\u001b[O",
    ];
    for (const reply of replies) {
      terminal.localInput(reply);
      expect(await terminal.run(async () => {
        for (const byte of reply) terminal.localInput(byte);
        return "ready";
      })).toBe("ready");
    }
  });

  test("keyboard input mixed with terminal replies still protects drafts", async () => {
    const terminal = mirror();
    terminal.localInput("\u001b]11;rgb:0000/0000/0000\u0007hello\u001b[?1;2c");
    await expect(terminal.run(async () => true)).rejects.toThrow("input draft");
    terminal.localInput("\u0015");
    expect(await terminal.run(async () => true)).toBe(true);
    terminal.localInput("\u001b[104u"); // Kitty keyboard protocol: h
    await expect(terminal.run(async () => true)).rejects.toThrow("input draft");
  });

  test("multiline bracketed paste remains a draft and later typing wins over an earlier Enter", async () => {
    for (const input of ["\u001b[200~first\r\nsecond\u001b[201~", "\rnew draft"]) {
      const terminal = mirror();
      for (const char of input) terminal.localInput(char);
      await expect(terminal.run(async () => true)).rejects.toThrow("input draft");
    }
  });

  test("retries Enter when Claude accepts a slash completion without executing it", async () => {
    let enters = 0;
    const terminal = mirror((key) => {
      if (key === "\r") enters++;
      if (key === "\u001b") draw(terminal, "❯\n");
      else draw(terminal, enters >= 2 ? claudeMenu : "❯ /model\n /model Set the AI model");
    });
    draw(terminal, "❯\n");
    await terminal.run(async () => {
      await terminal.openMenu("/model", "Select model");
      await terminal.closeMenu();
    });
    expect(enters).toBe(2);
  });

  test("local input and a switched session stop further automated keys", async () => {
    for (const reason of ["keyboard", "session"]) {
      const keys: string[] = [];
      let session = "one";
      const terminal = mirror((key) => keys.push(key), () => session);
      await expect(terminal.run(async () => {
        if (reason === "keyboard") terminal.localInput("x");
        else session = "two";
        await terminal.key("\r");
      })).rejects.toThrow(reason === "keyboard" ? "keyboard" : "session changed");
      expect(keys).toEqual([]);
    }
  });

  test("serializes controls and reports timeout without sending the pending key", async () => {
    const terminal = mirror();
    await terminal.run(async () => {
      await expect(terminal.run(async () => true)).rejects.toThrow("in progress");
      const now = Date.now;
      const start = now();
      Date.now = () => start + 26_000;
      try { await expect(terminal.key("\r")).rejects.toThrow("timed out"); }
      finally { Date.now = now; }
    });
  });
});

describe("Claude native plan controls", () => {
  test("enters once and restores the original mode without submitting an LLM prompt", async () => {
    let mode = "acceptEdits";
    const keys: string[] = [];
    const terminal = mirror((key) => {
      keys.push(key);
      if (key === "\r") mode = "plan";
      if (key === "\u001b[Z") mode = mode === "plan" ? "default" : "acceptEdits";
      draw(terminal, `❯\n${mode === "default" ? "" : mode === "plan" ? "plan mode on" : "accept edits on"}`);
    });
    draw(terminal, "❯\naccept edits on");
    const controls = new ClaudeNativeControls(terminal, () => "session");
    expect(await controls.setPlanMode(true)).toBe(true);
    const count = keys.length;
    expect(await controls.setPlanMode(true)).toBe(true);
    expect(keys).toHaveLength(count);
    expect(await controls.setPlanMode(false)).toBe(false);
    expect(mode).toBe("acceptEdits");
    expect(keys.filter((key) => key.includes("/plan"))).toEqual(["\u001b[200~/plan\u001b[201~"]);
    expect(keys).not.toContain("/plan off");
  });

  test("does not reuse a previous session's permission mode", async () => {
    let session = "one";
    let mode = "bypassPermissions";
    const terminal = mirror((key) => {
      if (key === "\r") mode = "plan";
      if (key === "\u001b[Z") mode = "default";
      draw(terminal, `❯\n${mode === "plan" ? "plan mode on" : ""}`);
    });
    draw(terminal, "❯\nbypass permissions on");
    const controls = new ClaudeNativeControls(terminal, () => session);
    await controls.setPlanMode(true);
    session = "two";
    expect(await controls.setPlanMode(false)).toBe(false);
    expect(mode).toBe("default");
  });
});

test("Claude model selection traverses hidden rows, skips disabled entries, and detects stale labels", async () => {
  const labels = ["Disabled", "Model Two", "Model Three", "Model Four", "Model Five", "Model Six", "Model Seven"];
  let focus = 4;
  let current = 4;
  let menu = false;
  const terminal = mirror((key) => {
    if (key === "\r") { menu = true; focus = current; }
    if (key === "\u001b[B") focus = Math.min(6, focus + 1);
    if (key === "\u001b[A") focus = Math.max(1, focus - 1);
    if (key === "s") { current = focus; menu = false; }
    if (key === "\u001b") menu = false;
    render();
  });
  function render() {
    const start = Math.max(0, focus - 1);
    const rows = labels.slice(start, start + 3).map((label, index) => {
      const item = start + index;
      return `${item === focus ? "❯" : " "} ${item + 1}. ${label}${item === current ? " ✔" : ""}`;
    });
    draw(terminal, menu ? `Select model\n${rows.join("\n")}\ns to use this session only` : "❯\n");
  }
  render();
  const controls = new ClaudeNativeControls(terminal, () => "session");
  const models = await controls.listModels();
  expect(models.map((model) => model.displayName)).toEqual(labels.slice(1));
  expect(models.find((model) => model.isCurrent)?.displayName).toBe("Model Five");
  await controls.selectModel(models[1]!.id);
  expect(current).toBe(2);
  labels[3] = "Replacement Model";
  let failure = "";
  try { await controls.selectModel(models[2]!.id); }
  catch (error) { failure = String(error); }
  expect(failure).toContain("list changed");
  expect(menu).toBe(false);
}, 10_000);
