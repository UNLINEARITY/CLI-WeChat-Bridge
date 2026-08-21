import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildCliEnvironment,
  buildClaudeCliArgs,
  buildCodexCliArgs,
  buildCodexApprovalRequest,
  buildCodexPermissionsRequestApprovalResponse,
  buildCodexUserInputRequest,
  buildPtySpawnOptions,
  buildShellInputPayload,
  buildShellProfileCommand,
  createBridgeAdapter,
  extractCodexFinalTextFromItem,
  extractCodexThreadFollowIdFromStatusChanged,
  extractCodexThreadStartedThreadId,
  extractCodexUserMessageText,
  findRecentCodexSessionFileForCwd,
  getCodexApprovalAutoResponse,
  getCodexWechatOutboundAttachmentDenyMessage,
  hasClaudeNoAltScreenOption,
  isClaudeInvalidResumeError,
  listCodexResumeThreads,
  matchesCodexSessionMeta,
  resolveDefaultAdapterCommand,
  resolveShellRuntime,
  resolveSpawnTarget,
  shouldAutoCompleteCodexWechatTurnAfterFinalReply,
  shouldIgnoreCodexSessionReplayEntry,
  shouldRecoverCodexStaleBusyState,
} from "../../src/bridge/bridge-adapters.ts";
import { CodexPtyAdapter } from "../../src/bridge/bridge-adapters.codex.ts";
import {
  ensureClaudeWorkspaceTrustAccepted,
  normalizeClaudeProjectConfigKey,
} from "../../src/bridge/bridge-adapters.claude.ts";
import {
  ShellAdapter,
  ShellCommandRejectedError,
} from "../../src/bridge/bridge-adapters.shell.ts";
import { buildWechatInboundPrompt } from "../../src/bridge/bridge-utils.ts";

const tempDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wechat-bridge-adapter-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf-8");
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveSpawnTarget", () => {
  test("keeps an explicit executable path unchanged", () => {
    const tempDir = makeTempDirectory();
    const executableName = process.platform === "win32" ? "tool.exe" : "tool";
    const executablePath = path.join(tempDir, executableName);
    writeFile(executablePath);

    const target = resolveSpawnTarget(executablePath, "shell");

    expect(target.file).toBe(path.resolve(executablePath));
    expect(target.args).toEqual([]);
  });

  test("prefers cmd launcher over ps1 on Windows when vendor exe is missing", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const cmdPath = path.join(npmBinDirectory, "codex.cmd");
    const ps1Path = path.join(npmBinDirectory, "codex.ps1");
    writeFile(cmdPath);
    writeFile(ps1Path);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    expect(target.args).toHaveLength(4);
    expect(target.args[3]).toContain("codex.cmd");
    expect(target.args[3]).not.toContain("codex.ps1");
  });

  test("prefers bundled vendor exe for codex on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const launcherPath = path.join(npmBinDirectory, "codex.cmd");
    const vendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      ".codex-test",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    writeFile(launcherPath);
    writeFile(vendorExePath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(vendorExePath);
    expect(target.args).toEqual([]);
  });

  test("prefers the installed package vendor exe before hidden staging directories", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const launcherPath = path.join(npmBinDirectory, "codex.cmd");
    const packageVendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    const hiddenVendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      ".codex-test",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    writeFile(launcherPath);
    writeFile(packageVendorExePath);
    writeFile(hiddenVendorExePath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(packageVendorExePath);
    expect(target.args).toEqual([]);
  });

  test("passes forwarded exec args through the cmd wrapper on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const cmdPath = path.join(npmBinDirectory, "codex.cmd");
    writeFile(cmdPath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
      forwardArgs: ["exec", "--json", "hello"],
    });

    expect(target.file.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    expect(target.args[3]).toContain("codex.cmd");
    expect(target.args[3]).toContain("exec");
    expect(target.args[3]).toContain("--json");
    expect(target.args[3]).toContain("hello");
  });

  test("launches claude.exe directly on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const binDirectory = path.join(tempDir, "bin");
    const claudeExePath = path.join(binDirectory, "claude.exe");
    writeFile(claudeExePath);

    const target = resolveSpawnTarget("claude", "claude", {
      platform: "win32",
      env: {
        PATH: binDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(claudeExePath);
    expect(target.args).toEqual([]);
  });
});

describe("resolveDefaultAdapterCommand", () => {
  test("keeps codex and claude defaults unchanged", () => {
    expect(resolveDefaultAdapterCommand("codex", { platform: "linux" })).toBe("codex");
    expect(resolveDefaultAdapterCommand("claude", { platform: "darwin" })).toBe("claude");
  });

  test("keeps the Windows shell default unchanged", () => {
    expect(resolveDefaultAdapterCommand("shell", { platform: "win32" })).toBe("powershell.exe");
  });

  test("selects the first available non-Windows shell in priority order", () => {
    const tempDir = makeTempDirectory();
    const binDirectory = path.join(tempDir, "bin");
    const zshPath = path.join(binDirectory, "zsh");
    writeFile(zshPath);

    expect(
      resolveDefaultAdapterCommand("shell", {
        platform: "linux",
        env: { PATH: binDirectory },
      }),
    ).toBe("zsh");
  });

  test("throws a helpful error when no non-Windows shell is available", () => {
    expect(() =>
      resolveDefaultAdapterCommand("shell", {
        platform: "linux",
        env: { PATH: "" },
      }),
    ).toThrow("Tried: pwsh, bash, zsh, sh");
  });
});

describe("buildCliEnvironment", () => {
  test("passes through the full Windows CLI environment for codex and claude", () => {
    const env = buildCliEnvironment("codex", {
      platform: "win32",
      env: {
        PATH: "C:\\tools",
        USERPROFILE: "C:\\Users\\tester",
        FOO: "bar",
        ANTHROPIC_BASE_URL: "https://relay.example.com",
        ANTHROPIC_AUTH_TOKEN: "sk-test",
      },
    });

    expect(env.PATH).toBe("C:\\tools");
    expect(env.HOME).toBe("C:\\Users\\tester");
    expect(env.FOO).toBe("bar");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://relay.example.com");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
  });

  test("passes through the non-Windows CLI environment", () => {
    const env = buildCliEnvironment("claude", {
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        HOME: "/home/tester",
        FOO: "bar",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/tester");
    expect(env.FOO).toBe("bar");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
  });

  test("preserves existing no_proxy values while adding local loopback hosts", () => {
    const env = buildCliEnvironment("codex", {
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        HOME: "/home/tester",
        NO_PROXY: "example.com,localhost",
        no_proxy: "internal.test,127.0.0.1",
      },
    });

    expect(env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,::1");
    expect(env.no_proxy).toBe("internal.test,127.0.0.1,localhost,::1");
  });
});

describe("buildPtySpawnOptions", () => {
  test("enables ConPTY only on Windows builds that support it", () => {
    expect(
      (buildPtySpawnOptions({
        cwd: "C:\\repo",
        env: { TERM: "xterm-256color" },
        platform: "win32",
        osRelease: "10.0.26200",
      }) as any).useConpty,
    ).toBe(true);

    expect(
      (buildPtySpawnOptions({
        cwd: "C:\\repo",
        env: { TERM: "xterm-256color" },
        platform: "win32",
        osRelease: "10.0.17763",
      }) as any).useConpty,
    ).toBeUndefined();

    expect(
      (buildPtySpawnOptions({
        cwd: "/repo",
        env: { TERM: "xterm-256color" },
        platform: "linux",
      }) as any).useConpty,
    ).toBeUndefined();
  });
});

describe("resolveShellRuntime", () => {
  test("builds non-Windows PowerShell launch args", () => {
    expect(resolveShellRuntime("pwsh", { platform: "linux" })).toEqual({
      family: "powershell",
      launchArgs: ["-NoLogo", "-NoProfile", "-NoExit"],
    });
  });

  test("builds Windows PowerShell launch args for a long-lived shell session", () => {
    expect(resolveShellRuntime("powershell.exe", { platform: "win32" })).toEqual({
      family: "powershell",
      launchArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit"],
    });
  });

  test("builds POSIX shell launch args", () => {
    expect(resolveShellRuntime("/bin/bash", { platform: "darwin" })).toEqual({
      family: "posix",
      launchArgs: ["-i"],
    });
  });

  test("rejects unsupported shell executables", () => {
    expect(() => resolveShellRuntime("fish", { platform: "linux" })).toThrow(
      "Unsupported shell executable",
    );
  });
});

describe("shell helpers", () => {
  test("builds a PowerShell profile source command", () => {
    expect(buildShellProfileCommand("C:\\profiles\\wechat.ps1", "powershell")).toContain(
      'C:\\profiles\\wechat.ps1',
    );
  });

  test("quotes POSIX shell profile paths safely", () => {
    const command = buildShellProfileCommand("/tmp/it's-profile.sh", "posix");
    expect(command.startsWith(". '")).toBe(true);
    expect(command).toContain(`it'"'"'s-profile.sh'`);
  });

  test("builds shell input payloads with a completion sentinel", () => {
    expect(buildShellInputPayload("Get-ChildItem", "powershell")).toContain(
      "[System.Convert]::FromBase64String",
    );
    expect(buildShellInputPayload("Get-ChildItem", "powershell")).toContain(
      "__WECHAT_BRIDGE_DONE__",
    );
    expect(buildShellInputPayload("Get-ChildItem", "powershell")).not.toContain(
      "__wechatBridgeInvoke",
    );
    expect(buildShellInputPayload("ls", "posix")).toContain(
      "printf '%s:%s\\n'",
    );
  });

  test("supports a custom shell completion marker", () => {
    expect(
      buildShellInputPayload("Get-ChildItem", "powershell", "__WECHAT_BRIDGE_DONE__:abc"),
    ).toContain('[System.Convert]::FromBase64String');
    expect(
      buildShellInputPayload("ls", "posix", "__WECHAT_BRIDGE_DONE__:abc"),
    ).toContain("printf '%s:%s\\n' '__WECHAT_BRIDGE_DONE__:abc'");
  });
});

describe("ShellAdapter", () => {
  test("handles shell output without throwing when a command completes", () => {
    const adapter = new ShellAdapter({
      kind: "shell",
      command: process.platform === "win32" ? "powershell.exe" : "bash",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const internal = adapter as unknown as {
      currentCompletionMarker: string;
      currentPreview: string;
      handleData: (text: string) => void;
      hasAcceptedInput: boolean;
      state: { status: string };
    };
    internal.currentCompletionMarker = "__WECHAT_BRIDGE_DONE__:cmd_0";
    internal.currentPreview = "echo hello";
    internal.hasAcceptedInput = true;
    internal.state.status = "busy";

    expect(() => {
      internal.handleData("hello\r\n__WECHAT_BRIDGE_DONE__:cmd_0:0\r\n");
    }).not.toThrow();

    expect(
      events.some((event) => event.type === "stdout" && event.text === "hello"),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "task_complete" && event.exitCode === 0),
    ).toBe(true);
  });

  test("suppresses echoed shell input and waits for a split completion marker", () => {
    const adapter = new ShellAdapter({
      kind: "shell",
      command: process.platform === "win32" ? "powershell.exe" : "bash",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const internal = adapter as unknown as {
      currentCompletionMarker: string;
      currentPreview: string;
      expectedEchoLines: string[];
      handleData: (text: string) => void;
      hasAcceptedInput: boolean;
      state: { status: string; activeTurnOrigin?: string };
    };
    internal.currentCompletionMarker = "__WECHAT_BRIDGE_DONE__:cmd_1";
    internal.currentPreview = "echo hello";
    internal.expectedEchoLines = ["echo hello"];
    internal.hasAcceptedInput = true;
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";

    internal.handleData("echo hello\r\nhello\r\n__WECHAT_BRIDGE_DONE__:cmd_");

    expect(events.map((event) => event.type)).toEqual(["stdout"]);
    expect(events[0]?.text).toBe("hello");

    internal.handleData("1:0\r\n");

    expect(events.map((event) => event.type)).toEqual(["stdout", "status", "task_complete"]);
    expect(events[2]?.exitCode).toBe(0);
    expect(adapter.getState().status).toBe("idle");
  });

  test("strips concatenated PowerShell wrapper noise before forwarding visible output", () => {
    const adapter = new ShellAdapter({
      kind: "shell",
      command: "powershell.exe",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const internal = adapter as unknown as {
      currentPreview: string;
      expectedEchoLines: string[];
      handleData: (text: string) => void;
      hasAcceptedInput: boolean;
      state: { status: string; activeTurnOrigin?: string };
    };
    internal.currentPreview = "python";
    internal.expectedEchoLines = [
      '$decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("cHl0aG9u"))',
      "$scriptBlock = [scriptblock]::Create($decoded)",
      "& $scriptBlock",
    ];
    internal.hasAcceptedInput = true;
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";

    internal.handleData(
      [
        "$__wechatBridgePreviousErrorActionPreference = $ErrorActionPreferencePS>$ErrorActionPreference = 'Continue'PS>$global:LASTEXITCODE = 0PS>> try {",
        '>> $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("cHl0aG9u"))',
        ">> $scriptBlock = [scriptblock]::Create($decoded)",
        ">> & $scriptBlock",
        ">> } catch {",
        ">>   Write-Error $_",
        ">>   $global:LASTEXITCODE = 1",
        ">> } finally {",
        '>>   Write-Output "__WECHAT_BRIDGE_DONE__:$global:LASTEXITCODE"',
        ">>   $ErrorActionPreference = $__wechatBridgePreviousErrorActionPreference",
        '>> }Python 3.14.0 on win32',
        "",
      ].join("\r\n"),
    );

    expect(events.map((event) => event.type)).toEqual(["stdout"]);
    expect(events[0]?.text).toBe("Python 3.14.0 on win32");
  });

  test("rejects interactive shell entry commands before writing to the worker", async () => {
    const adapter = new ShellAdapter({
      kind: "shell",
      command: "powershell.exe",
      cwd: process.cwd(),
    });

    const internal = adapter as unknown as {
      pty: { write: (value: string) => void } | null;
    };
    internal.pty = {
      write: () => {
        throw new Error("interactive command should not be written to the PTY");
      },
    };

    await expect(adapter.sendInput("python")).rejects.toBeInstanceOf(
      ShellCommandRejectedError,
    );
  });

  test("accepts PowerShell completion sentinels prefixed by a bare prompt token", () => {
    const adapter = new ShellAdapter({
      kind: "shell",
      command: "powershell.exe",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const internal = adapter as unknown as {
      currentCompletionMarker: string;
      currentPreview: string;
      handleData: (text: string) => void;
      hasAcceptedInput: boolean;
      state: { status: string; activeTurnOrigin?: string };
    };
    internal.currentCompletionMarker = "__WECHAT_BRIDGE_DONE__:cmd_3";
    internal.currentPreview = "python";
    internal.hasAcceptedInput = true;
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";

    internal.handleData("> __WECHAT_BRIDGE_DONE__:cmd_3:0\r\n");

    expect(events.map((event) => event.type)).toEqual(["status", "task_complete"]);
    expect(events[1]?.exitCode).toBe(0);
    expect(adapter.getState().status).toBe("idle");
  });

  test("interrupt settles the active shell command once and ignores late completion output", async () => {
    const adapter = new ShellAdapter({
      kind: "shell",
      command: process.platform === "win32" ? "powershell.exe" : "bash",
      cwd: process.cwd(),
    });
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    const internal = adapter as unknown as {
      currentCompletionMarker: string;
      currentPreview: string;
      handleData: (text: string) => void;
      hasAcceptedInput: boolean;
      pty: { write: (value: string) => void } | null;
      state: { status: string; activeTurnOrigin?: string };
    };
    internal.pty = {
      write: () => undefined,
    };
    internal.currentCompletionMarker = "__WECHAT_BRIDGE_DONE__:cmd_2";
    internal.currentPreview = "sleep 60";
    internal.hasAcceptedInput = true;
    internal.state.status = "busy";
    internal.state.activeTurnOrigin = "wechat";

    await adapter.interrupt();
    await wait(1_600);

    internal.handleData("__WECHAT_BRIDGE_DONE__:cmd_2:130\r\n");

    expect(events.filter((event) => event.type === "task_complete")).toHaveLength(1);
    expect(adapter.getState().status).toBe("idle");
  });
});

describe("matchesCodexSessionMeta", () => {
  test("matches the expected cwd and thread id", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");
    const cwd = "C:\\workspace\\wechat-bridge";

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_123",
          cwd,
          source: "cli",
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd,
          startedAtMs,
          threadId: "thread_123",
        },
      ),
    ).toBe(true);
  });

  test("rejects a session from the same cwd when the source does not match", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");
    const cwd = "C:\\workspace\\wechat-bridge";

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_123",
          cwd,
          source: { custom: "cli" },
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd,
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });

  test("rejects a session that started too far before the bridge session", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");
    const cwd = "C:\\workspace\\wechat-bridge";

    expect(
      matchesCodexSessionMeta(
        {
          id: "thread_999",
          cwd,
          source: "wechat_bridge",
          timestamp: "2026-03-22T14:55:00.000Z",
        },
        {
          cwd,
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });
});

describe("buildCodexApprovalRequest", () => {
  test("formats command execution approvals for WeChat", () => {
    const request = buildCodexApprovalRequest(
      "item/commandExecution/requestApproval",
      {
        command: "git push origin main",
        cwd: "C:\\repo",
        reason: "Network access is required to push this branch.",
      },
    );

    expect(request).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before running a command: Network access is required to push this branch.",
      commandPreview: "git push origin main (C:\\repo)",
    });
  });

  test("formats file change approvals for WeChat", () => {
    const request = buildCodexApprovalRequest(
      "item/fileChange/requestApproval",
      {
        grantRoot: "C:\\repo\\generated",
        reason: "Extra write access is required for generated assets.",
      },
    );

    expect(request).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before applying a file change: Extra write access is required for generated assets.",
      commandPreview: "C:\\repo\\generated",
    });
  });

  test("detects outbound attachment staging approvals", () => {
    expect(
      getCodexWechatOutboundAttachmentDenyMessage(
        "item/commandExecution/requestApproval",
        {
          command:
            'cp "C:/Users/unlin/Desktop/report.docx" "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23/report.docx"',
        },
      ),
    ).toContain("original absolute local file path");

    expect(
      getCodexWechatOutboundAttachmentDenyMessage(
        "item/fileChange/requestApproval",
        {
          grantRoot:
            "C:\\Users\\unlin\\.claude\\channels\\wechat\\outbound-attachments\\2026-05-23",
        },
      ),
    ).toContain("original absolute local file path");

    expect(
      getCodexWechatOutboundAttachmentDenyMessage(
        "item/permissions/requestApproval",
        {
          permissions: {
            fileSystem: {
              write: [
                "C:\\Users\\unlin\\.cli-bridge\\outbound-attachments\\2026-05-23",
              ],
            },
          },
        },
      ),
    ).toContain("original absolute local file path");

    expect(
      getCodexWechatOutboundAttachmentDenyMessage(
        "item/commandExecution/requestApproval",
        {
          command:
            'ls "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23"',
        },
      ),
    ).toBeNull();
  });

  test("formats and resolves Codex request_permissions prompts", () => {
    expect(
      buildCodexApprovalRequest("item/permissions/requestApproval", {
        reason: "Need to inspect generated files.",
        permissions: {
          network: {
            enabled: true,
          },
          fileSystem: {
            read: ["C:\\repo\\generated"],
            write: ["C:\\repo\\generated"],
          },
        },
      }),
    ).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before granting extra permissions: Need to inspect generated files.",
      commandPreview:
        "network access; read: C:\\repo\\generated; write: C:\\repo\\generated",
    });

    expect(buildCodexPermissionsRequestApprovalResponse()).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(
      buildCodexPermissionsRequestApprovalResponse(
        {
          permissions: {
            network: {
              enabled: true,
            },
            fileSystem: {
              read: null,
              write: ["C:\\repo\\generated"],
            },
          },
        },
        "confirm",
      ),
    ).toEqual({
      permissions: {
        network: {
          enabled: true,
        },
        fileSystem: {
          read: null,
          write: ["C:\\repo\\generated"],
        },
      },
      scope: "turn",
    });
    expect(
      buildCodexPermissionsRequestApprovalResponse(
        {
          permissions: {
            network: {
              enabled: true,
            },
          },
        },
        "confirm",
        { strictAutoReview: true },
      ),
    ).toEqual({
      permissions: {
        network: {
          enabled: true,
        },
      },
      scope: "turn",
      strictAutoReview: true,
    });
  });

  test("auto-approves only low-risk Codex approval requests", () => {
    expect(
      getCodexApprovalAutoResponse(
        "item/commandExecution/requestApproval",
        {
          command: "rg \"TODO\" src",
          cwd: "C:\\repo",
          availableDecisions: ["accept", "cancel"],
        },
        { CLI_BRIDGE_STRICT_APPROVAL: "true" },
      ),
    ).toBeNull();

    expect(
      getCodexApprovalAutoResponse("item/commandExecution/requestApproval", {
        command: "rg \"TODO\" src",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "cancel"],
      })?.result,
    ).toEqual({ decision: "accept" });

    expect(
      getCodexApprovalAutoResponse("item/commandExecution/requestApproval", {
        command: "rm -rf build",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "cancel"],
      }),
    ).toBeNull();

    expect(
      getCodexApprovalAutoResponse("item/commandExecution/requestApproval", {
        command: "git status",
        cwd: "C:\\repo",
        availableDecisions: ["cancel"],
      }),
    ).toBeNull();

    expect(
      getCodexApprovalAutoResponse("item/permissions/requestApproval", {
        permissions: {
          network: {
            enabled: true,
          },
          fileSystem: {
            read: null,
            write: ["C:\\repo\\generated"],
          },
        },
      })?.result,
    ).toEqual({
      permissions: {
        network: {
          enabled: true,
        },
        fileSystem: {
          read: null,
          write: ["C:\\repo\\generated"],
        },
      },
      scope: "turn",
      strictAutoReview: true,
    });

    expect(
      getCodexApprovalAutoResponse("item/permissions/requestApproval", {
        permissions: {
          fileSystem: {
            write: ["/"],
          },
        },
      }),
    ).toBeNull();

    expect(
      getCodexApprovalAutoResponse("item/permissions/requestApproval", {
        permissions: {
          fileSystem: {
            entries: [
              {
                path: {
                  type: "special",
                  value: {
                    kind: "root",
                  },
                },
                access: "write",
              },
            ],
          },
        },
      }),
    ).toBeNull();
  });

  test("formats Codex request_user_input prompts for WeChat", () => {
    expect(
      buildCodexUserInputRequest({
        questions: [
          {
            id: "format",
            header: "Format",
            question: "Which output format should I use?",
            options: [
              {
                label: "Markdown",
                description: "Return a Markdown report.",
              },
              {
                label: "DOCX",
                description: "Create a Word document.",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      summary: "Codex needs more information before the tool can continue.",
      questions: [
        {
          id: "format",
          header: "Format",
          question: "Which output format should I use?",
          isOther: false,
          isSecret: false,
          options: [
            {
              label: "Markdown",
              description: "Return a Markdown report.",
            },
            {
              label: "DOCX",
              description: "Create a Word document.",
            },
          ],
        },
      ],
    });
  });
});

describe("buildCodexCliArgs", () => {
  test("builds the standard remote tui args", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        profile: "wechat",
        inlineMode: false,
      }),
    ).toEqual([
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
    ]);
  });

  test("builds a real codex resume command for panel thread switching", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        resumeThreadId: "thread_123",
        profile: "wechat",
      }),
    ).toEqual([
      "resume",
      "thread_123",
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
    ]);
  });

  test("keeps inline mode for embedded codex rendering", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        inlineMode: true,
      }),
    ).toEqual([
      "--remote",
      "ws://127.0.0.1:8123",
      "--no-alt-screen",
    ]);
  });

  test("appends extra codex CLI args after bridge-managed args", () => {
    expect(
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        profile: "wechat",
        extraCliArgs: ["--yolo", "--model", "gpt-5.2"],
      }),
    ).toEqual([
      "--remote",
      "ws://127.0.0.1:8123",
      "--profile",
      "wechat",
      "--yolo",
      "--model",
      "gpt-5.2",
    ]);
  });

  test("rejects extra codex args that would override the bridge remote", () => {
    expect(() =>
      buildCodexCliArgs("ws://127.0.0.1:8123", {
        extraCliArgs: ["--remote=ws://127.0.0.1:9999"],
      }),
    ).toThrow(/--remote/);
  });
});

describe("Claude CLI compatibility", () => {
  test("detects whether the installed help text exposes --no-alt-screen", () => {
    expect(
      hasClaudeNoAltScreenOption(`Options:\n  --settings <file>\n  --no-alt-screen\n`),
    ).toBe(true);
    expect(
      hasClaudeNoAltScreenOption(`Options:\n  --settings <file>\n  --resume [value]\n`),
    ).toBe(false);
  });

  test("builds Claude companion args without unsupported alt-screen flags", () => {
    expect(
      buildClaudeCliArgs({
        settingsFilePath: "/tmp/claude-settings.json",
        resumeConversationId: "session_123",
        profile: "wechat",
      }),
    ).toEqual([
      "--settings",
      "/tmp/claude-settings.json",
      "--resume",
      "session_123",
      "--profile",
      "wechat",
    ]);
  });

  test("keeps --no-alt-screen only when a compatible Claude build exposes it", () => {
    expect(
      buildClaudeCliArgs({
        settingsFilePath: "/tmp/claude-settings.json",
        includeNoAltScreen: true,
      }),
    ).toEqual(["--no-alt-screen", "--settings", "/tmp/claude-settings.json"]);
  });

  test("appends extra Claude CLI args after bridge-managed settings", () => {
    expect(
      buildClaudeCliArgs({
        settingsFilePath: "/tmp/claude-settings.json",
        extraCliArgs: ["--debug"],
      }),
    ).toEqual(["--settings", "/tmp/claude-settings.json", "--debug"]);
  });

  test("rejects extra Claude args that would override bridge settings", () => {
    expect(() =>
      buildClaudeCliArgs({
        settingsFilePath: "/tmp/claude-settings.json",
        extraCliArgs: ["--settings", "/tmp/other-settings.json"],
      }),
    ).toThrow(/--settings/);
  });

  test("recognizes Claude invalid resume errors", () => {
    expect(
      isClaudeInvalidResumeError(
        "No conversation found with session ID: 019d1b3c-bf74-7e31-b105-2f28e27fa969",
      ),
    ).toBe(true);
    expect(isClaudeInvalidResumeError("Claude is ready.")).toBe(false);
  });

  test("keeps Claude runtime session and resume conversation ids separate", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
      initialSharedSessionId: "runtime-session-123",
      initialResumeConversationId: "resume-conversation-456",
      initialTranscriptPath: "/tmp/resume-conversation-456.jsonl",
    });

    expect(adapter.getState()).toMatchObject({
      sharedSessionId: "runtime-session-123",
      activeRuntimeSessionId: "runtime-session-123",
      resumeConversationId: "resume-conversation-456",
      transcriptPath: "/tmp/resume-conversation-456.jsonl",
    });
  });

  test("ignores saved Claude resume ids when start launcher requests a fresh session", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
      sessionStartMode: "new",
      initialSharedSessionId: "runtime-session-123",
      initialResumeConversationId: "resume-conversation-456",
      initialTranscriptPath: "/tmp/resume-conversation-456.jsonl",
    });

    expect(adapter.getState().sharedSessionId).toBeUndefined();
    expect(adapter.getState().activeRuntimeSessionId).toBeUndefined();
    expect(adapter.getState().resumeConversationId).toBeUndefined();
    expect(adapter.getState().transcriptPath).toBeUndefined();
  });

  test("marks the Claude workspace trust dialog accepted in Claude config", () => {
    const homeDir = makeTempDirectory();
    const cwd = path.join(homeDir, "project");
    const projectKey = normalizeClaudeProjectConfigKey(cwd);
    writeTextFile(
      path.join(homeDir, ".claude.json"),
      JSON.stringify(
        {
          numStartups: 3,
          projects: {
            [projectKey]: {
              allowedTools: ["Read"],
              hasTrustDialogAccepted: false,
            },
          },
        },
        null,
        2,
      ),
    );

    expect(ensureClaudeWorkspaceTrustAccepted(cwd, homeDir)).toBe(true);
    const config = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".claude.json"), "utf8"),
    ) as {
      numStartups: number;
      projects: Record<string, { allowedTools?: string[]; hasTrustDialogAccepted?: boolean }>;
    };

    expect(config.numStartups).toBe(3);
    expect(config.projects[projectKey]).toMatchObject({
      allowedTools: ["Read"],
      hasTrustDialogAccepted: true,
    });
    expect(ensureClaudeWorkspaceTrustAccepted(cwd, homeDir)).toBe(false);
  });

  test("creates a Claude project trust entry when the config has no project yet", () => {
    const homeDir = makeTempDirectory();
    const cwd = path.join(homeDir, "new-project");
    const projectKey = normalizeClaudeProjectConfigKey(cwd);
    writeTextFile(path.join(homeDir, ".claude.json"), "{\"projects\":{}}\n");

    expect(ensureClaudeWorkspaceTrustAccepted(cwd, homeDir)).toBe(true);
    const config = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".claude.json"), "utf8"),
    ) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };

    expect(config.projects[projectKey]).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  test("submits single-line Claude WeChat input with a delayed final enter", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const writes: string[] = [];
    adapter.setEventSink(() => undefined);
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write(value: string) {
        writes.push(value);
      },
      kill() {},
    };

    await adapter.sendInput("Send a short reply");

    expect(writes).toEqual(["Send a short reply", "\r"]);
    expect(adapter.getState()).toMatchObject({
      status: "busy",
      activeTurnOrigin: "wechat",
    });

    await adapter.dispose();
  });

  test("submits generated WeChat attachment guidance as bracketed paste before enter", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const writes: string[] = [];
    adapter.setEventSink(() => undefined);
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write(value: string) {
        writes.push(value);
      },
      kill() {},
    };

    const prompt = buildWechatInboundPrompt(
      "Please send any document from Desktop to WeChat.",
    );

    expect(prompt).toContain("[WeChat bridge note]");
    expect(prompt).toContain("\n");

    await adapter.sendInput(prompt);

    expect(writes).toEqual([`\u001b[200~${prompt}\u001b[201~`, "\r"]);
    expect(adapter.getState()).toMatchObject({
      status: "busy",
      activeTurnOrigin: "wechat",
    });

    await adapter.dispose();
  });

  test("auto-confirms Claude workspace trust prompt during startup", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    const writes: string[] = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write(value: string) {
        writes.push(value);
      },
      kill() {},
    };

    adapter.handleData(
      "Accessing workspace:\r\n\r\n C:\\Users\\unlin\r\n\r\n Quick safety check: Is this a project ",
    );
    expect(writes).toEqual([]);

    adapter.handleData(
      "you created or one you trust? If not, review it first.\r\n\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to cancel",
    );
    adapter.handleData(
      "you created or one you trust? If not, review it first.\r\n\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to cancel",
    );

    expect(writes).toEqual(["\r"]);
    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
  });

  test("does not auto-confirm Claude workspace trust text during an active WeChat turn", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const writes: string[] = [];
    adapter.setEventSink(() => undefined);
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.pty = {
      pid: 1234,
      write(value: string) {
        writes.push(value);
      },
      kill() {},
    };

    adapter.handleData(
      "Accessing workspace:\r\n\r\n C:\\Users\\unlin\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to cancel",
    );

    expect(writes).toEqual([]);
  });

  test("suppresses raw Claude PTY output and waits for structured approval hooks", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleData("Thinking...\r\nReviewing files...\r\n");

    expect(events).toEqual([]);

    adapter.handleData("Do you want to allow this? (y/n)\r\n");

    expect(events).toEqual([]);

    adapter.handleClaudePermissionRequest(
      "request-123",
      {
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf build",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );

    expect(events.map((event) => event.type)).toEqual(["status", "approval_required"]);
    expect(adapter.pendingApproval).toMatchObject({
      summary: "Claude permission is required for Bash.",
      commandPreview: "Bash: rm -rf build",
      confirmInput: "y\r",
      denyInput: "n\r",
    });

    adapter.flushPendingClaudeHookApprovals();
  });

  test("auto-approves low-risk Claude Bash approvals without WeChat prompts", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    const socketPayloads: string[] = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-low-risk",
      {
        tool_name: "Bash",
        tool_input: {
          command:
            'find /c/Nonlinear/ob/ -type f -name "*.md" 2>/dev/null | xargs grep -l -i reinforcement 2>/dev/null | head -10',
        },
      },
      {
        end(payload: string) {
          socketPayloads.push(payload);
        },
        destroy() {},
      } as any,
    );

    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.getState().status).toBe("busy");
    expect(adapter.getState().pendingApproval ?? null).toBeNull();
    const response = JSON.parse(socketPayloads[0]!.trim()) as {
      requestId: string;
      stdout: string;
    };
    expect(response.requestId).toBe("request-low-risk");
    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  test("auto-approves low-risk Claude read tools without WeChat prompts", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    const socketPayloads: string[] = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-read",
      {
        tool_name: "Read",
        tool_input: {
          file_path: "C:\\Nonlinear\\ob\\note.md",
        },
      },
      {
        end(payload: string) {
          socketPayloads.push(payload);
        },
        destroy() {},
      } as any,
    );

    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    const response = JSON.parse(socketPayloads[0]!.trim()) as {
      requestId: string;
      stdout: string;
    };
    expect(response.requestId).toBe("request-read");
    expect(JSON.parse(response.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  test("keeps high-risk Claude approvals actionable through WeChat", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-high-risk",
      {
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf build",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );

    expect(events.map((event) => event.type)).toEqual(["status", "approval_required"]);
    expect(adapter.pendingApproval).toMatchObject({
      summary: "Claude permission is required for Bash.",
      commandPreview: "Bash: rm -rf build",
    });

    adapter.flushPendingClaudeHookApprovals();
  });

  test("keeps structured Claude approvals actionable until they are resolved", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const socketPayloads: string[] = [];
    adapter.setEventSink(() => undefined);
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-persist",
      {
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf build",
        },
      },
      {
        end(payload: string) {
          socketPayloads.push(payload);
        },
        destroy() {},
      } as any,
    );

    await wait(25);
    const resolved = await adapter.resolveApproval("confirm");

    expect(resolved).toBe(true);
    expect(socketPayloads).toHaveLength(1);
    const response = JSON.parse(socketPayloads[0]!.trim()) as {
      requestId: string;
      stdout: string;
    };
    expect(response.requestId).toBe("request-persist");
    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  test("auto-denies Claude attempts to stage WeChat files in outbound directories", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    const socketPayloads: string[] = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-outbound",
      {
        tool_name: "Bash",
        tool_input: {
          command:
            'cp "C:/Users/unlin/Desktop/report.docx" "C:/Users/unlin/.claude/channels/wechat/outbound-attachments/2026-05-22/report.docx"',
        },
      },
      {
        end(payload: string) {
          socketPayloads.push(payload);
        },
        destroy() {},
      } as any,
    );

    expect(events).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.getState()).toMatchObject({
      status: "busy",
      pendingApproval: null,
    });
    const response = JSON.parse(socketPayloads[0]!.trim()) as {
      requestId: string;
      stdout: string;
    };
    expect(response.requestId).toBe("request-outbound");
    expect(JSON.parse(response.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          interrupt: false,
        },
      },
    });
    expect(response.stdout).toContain("original absolute local file path");
  });

  test("clears stale Claude remote approvals when the hook request is lost without a terminal fallback", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; level?: string }) =>
      events.push(event),
    );
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudePermissionRequest(
      "request-lost",
      {
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf /important",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );

    adapter.handleClosedClaudeHookApproval("request-lost");

    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.getState().pendingApproval).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        level: "warning",
      }),
    );
  });

  test("emits a single notice for long-running Claude WeChat turns", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; text?: string; level?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; level?: string }) =>
      events.push(event),
    );
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };
    adapter.workingNoticeDelayMs = 5;

    await adapter.sendInput("Review the failing Claude bridge tests");
    await wait(20);

    const noticeEvents = events.filter((event) => event.type === "notice");
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]).toMatchObject({
      level: "info",
      text: "Claude is still working on:\nReview the failing Claude bridge tests",
    });

    await wait(20);
    expect(events.filter((event) => event.type === "notice")).toHaveLength(1);

    await adapter.dispose();
  });

  test("cancels the pending Claude working notice when a structured approval is requested", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };
    adapter.workingNoticeDelayMs = 20;

    await adapter.sendInput("Run the risky shell command");
    adapter.handleData("Do you want to allow this? (y/n)\r\n");
    adapter.handleClaudePermissionRequest(
      "request-456",
      {
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf build",
        },
      },
      {
        end() {},
        destroy() {},
      } as any,
    );
    await wait(35);

    expect(events.filter((event) => event.type === "notice")).toHaveLength(0);
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);

    adapter.flushPendingClaudeHookApprovals();
    await adapter.dispose();
  });

  test("cancels the pending Claude working notice once the final reply arrives", async () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };
    adapter.workingNoticeDelayMs = 20;

    await adapter.sendInput("Summarize the repo state");
    adapter.handleClaudeStop({ last_assistant_message: "Done." });
    await wait(35);

    expect(events.filter((event) => event.type === "notice")).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "status",
      "final_reply",
      "task_complete",
    ]);

    await adapter.dispose();
  });

  test("falls back to the Claude transcript when the Stop hook omits the final reply", async () => {
    const tempDir = makeTempDirectory();
    const transcriptPath = path.join(tempDir, "resume-123.jsonl");
    writeTextFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Inspecting repo" }],
            stop_reason: null,
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered from transcript.\r\n\r\nSummary" }],
            stop_reason: "end_turn",
          },
        }),
      ].join("\n"),
    );

    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
      initialTranscriptPath: transcriptPath,
    }) as any;
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.pty = {
      pid: 1234,
      write() {},
      kill() {},
    };

    await adapter.sendInput("Summarize the repo state");
    adapter.handleClaudeStop({});

    expect(events.find((event) => event.type === "final_reply")?.text).toBe(
      "Recovered from transcript.\n\nSummary",
    );

    await adapter.dispose();
  });

  test("completes a Claude compact turn even when SessionStart keeps the same session", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
      initialSharedSessionId: "session-123",
      initialResumeConversationId: "resume-123",
      initialTranscriptPath: "/tmp/resume-123.jsonl",
    }) as any;
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.currentPreview = "/compact";
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleClaudeSessionStart({
      session_id: "session-123",
      source: "compact",
      transcript_path: "/tmp/resume-123.jsonl",
    });

    expect(adapter.getState()).toMatchObject({
      status: "idle",
      sharedSessionId: "session-123",
      activeRuntimeSessionId: "session-123",
      resumeConversationId: "resume-123",
      transcriptPath: "/tmp/resume-123.jsonl",
    });
    expect(events.map((event) => event.type)).toEqual(["notice", "status", "task_complete"]);
    expect(events[0]?.text).toBe(
      "Conversation was compacted. Bridge is ready for new WeChat messages.",
    );
  });

  test("detects Claude compact completion directly from PTY output", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.currentPreview = "/compact";
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleData("\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\r\n");

    expect(adapter.getState().status).toBe("idle");
    expect(events.map((event) => event.type)).toEqual(["notice", "status", "task_complete"]);
    expect(events[0]?.text).toBe(
      "Conversation was compacted. Bridge is ready for new WeChat messages.",
    );
  });

  test("detects Claude compact failure directly from PTY output", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; message?: string }> = [];
    adapter.setEventSink((event: { type: string; message?: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.currentPreview = "/compact";
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleData(
      'Error: Error during compaction: Error: Please run /login · API Error: 403 {"error":{"message":"","type":"upstream_error"}}\r\n',
    );

    expect(adapter.getState().status).toBe("idle");
    expect(events.map((event) => event.type)).toEqual(["status", "task_failed"]);
    expect(events[1]?.message).toBe(
      'Compact failed: Please run /login · API Error: 403 {"error":{"message":"","type":"upstream_error"}}',
    );
  });

  test("detects non-403 Claude compact failures without hardcoded login text", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; message?: string }> = [];
    adapter.setEventSink((event: { type: string; message?: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.currentPreview = "/compact";
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleData(
      'Error: Error during compaction: Error: API Error: 502 {"error":{"message":"proxy failed","type":"proxy_error"}}\r\n',
    );

    expect(adapter.getState().status).toBe("idle");
    expect(events.map((event) => event.type)).toEqual(["status", "task_failed"]);
    expect(events[1]?.message).toBe(
      'Compact failed: API Error: 502 {"error":{"message":"proxy failed","type":"proxy_error"}}',
    );
  });

  test("ignores duplicate Claude compact failures after the turn is already settled", () => {
    const adapter = createBridgeAdapter({
      kind: "claude",
      command: "claude",
      cwd: process.cwd(),
      renderMode: "companion",
    }) as any;
    const events: Array<{ type: string; message?: string }> = [];
    adapter.setEventSink((event: { type: string; message?: string }) => events.push(event));
    adapter.renderLocalOutput = () => undefined;
    adapter.hasAcceptedInput = true;
    adapter.currentPreview = "/compact";
    adapter.state.status = "busy";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleData("Error: Error during compaction: Error: Please run /login · API Error: 403\r\n");
    adapter.handleClaudeStopFailure({
      error: "Please run /login",
      error_details: "API Error: 403",
    });

    expect(events.filter((event) => event.type === "task_failed")).toHaveLength(1);
  });
});

describe("extractCodexThreadFollowIdFromStatusChanged", () => {
  test("accepts idle thread status notifications from the local panel", () => {
    expect(
      extractCodexThreadFollowIdFromStatusChanged({
        threadId: "thread_idle_123",
        status: {
          type: "idle",
        },
      }),
    ).toBe("thread_idle_123");
  });

  test("rejects notLoaded thread status notifications", () => {
    expect(
      extractCodexThreadFollowIdFromStatusChanged({
        threadId: "thread_not_loaded",
        status: {
          type: "notLoaded",
        },
      }),
    ).toBeNull();
  });
});

describe("extractCodexThreadStartedThreadId", () => {
  test("extracts the thread id from thread-started notifications", () => {
    expect(
      extractCodexThreadStartedThreadId({
        thread: {
          id: "thread_started_123",
          cwd: "C:\\repo",
          status: {
            type: "idle",
          },
        },
      }),
    ).toBe("thread_started_123");
  });

  test("returns null when the thread payload is missing", () => {
    expect(extractCodexThreadStartedThreadId({})).toBeNull();
  });
});

describe("shouldIgnoreCodexSessionReplayEntry", () => {
  test("skips historical entries before the thread-switch cutoff", () => {
    const cutoff = Date.parse("2026-03-23T10:00:00.000Z");

    expect(
      shouldIgnoreCodexSessionReplayEntry("2026-03-23T09:59:59.000Z", cutoff),
    ).toBe(true);
  });

  test("keeps entries written after the thread-switch cutoff", () => {
    const cutoff = Date.parse("2026-03-23T10:00:00.000Z");

    expect(
      shouldIgnoreCodexSessionReplayEntry("2026-03-23T10:00:01.000Z", cutoff),
    ).toBe(false);
  });

  test("treats missing timestamps as replay while the cutoff is active", () => {
    const cutoff = Date.parse("2026-03-23T10:00:00.000Z");

    expect(shouldIgnoreCodexSessionReplayEntry(undefined, cutoff)).toBe(true);
    expect(shouldIgnoreCodexSessionReplayEntry(undefined, null)).toBe(false);
  });
});

describe("shouldRecoverCodexStaleBusyState", () => {
  test("recovers when busy is set without any tracked turn context", () => {
    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(true);
  });

  test("does not recover when a turn is still active or pending", () => {
    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: true,
        hasActiveTurn: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: true,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: true,
        hasPendingUserInput: false,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: false,
        hasPendingUserInput: true,
      }),
    ).toBe(false);

    expect(
      shouldRecoverCodexStaleBusyState({
        status: "busy",
        pendingTurnStart: false,
        hasActiveTurn: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        activeTurnId: "turn_123",
      }),
    ).toBe(false);
  });
});

describe("shouldAutoCompleteCodexWechatTurnAfterFinalReply", () => {
  test("auto-completes a settled WeChat turn once final output is available", () => {
    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(true);
  });

  test("does not auto-complete local, incomplete, or still-active turns", () => {
    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "local",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: true,
        hasPendingUserInput: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasPendingUserInput: true,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_000,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: "turn_123",
        activeTurnId: "turn_123",
        activeTurnOrigin: "wechat",
        pendingTurnStart: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        hasFinalOutput: true,
        hasCompletedTurn: false,
        lastActivityAtMs: 1_500,
        nowMs: 2_100,
        settleDelayMs: 1_000,
      }),
    ).toBe(false);
  });
});

describe("Codex panel completion recovery", () => {
  test("polls a WeChat session completion while the app-server process is gone", async () => {
    const home = makeTempDirectory();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const cwd = path.join(home, "project");
    const threadId = "019e1505-1c23-7fb1-aee3-c24f89836864";
    const turnId = "019e1505-4c13-74c0-9991-664bc4e60f04";
    const sessionFilePath = path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "05",
      "11",
      `rollout-2026-05-11T11-11-56-${threadId}.jsonl`,
    );
    writeTextFile(
      sessionFilePath,
      [
        JSON.stringify({
          timestamp: "2026-05-11T03:12:09.281Z",
          type: "session_meta",
          payload: {
            id: threadId,
            timestamp: "2026-05-11T03:11:56.963Z",
            cwd,
            source: "vscode",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-11T03:12:13.770Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: turnId,
            last_agent_message: "done from session log",
          },
        }),
        "",
      ].join("\n"),
    );

    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd,
      renderMode: "headless",
    }) as any;
    const events: Array<{ type: string; text?: string; status?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; status?: string }) =>
      events.push(event),
    );
    adapter.sharedThreadId = threadId;
    adapter.state.sharedThreadId = threadId;
    adapter.state.sharedSessionId = threadId;
    adapter.state.startedAt = "2026-05-11T03:11:56.732Z";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId,
      turnId,
      origin: "wechat",
    };
    adapter.state.activeTurnId = turnId;
    adapter.state.activeTurnOrigin = "wechat";
    adapter.appServer = null;

    await adapter.pollSessionLog();

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "final_reply",
      "task_complete",
    ]);
    expect(events.find((event) => event.type === "final_reply")?.text).toBe(
      "done from session log",
    );
    expect(adapter.activeTurn).toBeNull();
    expect(adapter.state.status).toBe("idle");
  });

  test("does not replay historical local session entries on startup", async () => {
    const home = makeTempDirectory();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const cwd = path.join(home, "project");
    const threadId = "019e1505-1c23-7fb1-aee3-c24f89836864";
    const turnId = "019e1506-4c13-74c0-9991-664bc4e60f04";
    const sessionFilePath = path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "05",
      "11",
      `rollout-2026-05-11T11-11-56-${threadId}.jsonl`,
    );
    writeTextFile(
      sessionFilePath,
      [
        JSON.stringify({
          timestamp: "2026-05-11T03:12:09.281Z",
          type: "session_meta",
          payload: {
            id: threadId,
            timestamp: "2026-05-11T03:11:56.963Z",
            cwd,
            source: "vscode",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-11T03:12:10.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: turnId,
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-11T03:12:11.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "old local input",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-11T03:12:12.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "old local final",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-11T03:12:13.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: turnId,
            last_agent_message: "old local final",
          },
        }),
        "",
      ].join("\n"),
    );

    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd,
      renderMode: "headless",
    }) as any;
    const events: Array<{ type: string; text?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string }) => events.push(event));
    adapter.sharedThreadId = threadId;
    adapter.state.sharedThreadId = threadId;
    adapter.state.sharedSessionId = threadId;
    adapter.state.startedAt = "2026-05-11T03:13:00.000Z";
    adapter.state.status = "idle";
    adapter.appServer = {};

    await adapter.pollSessionLog();

    expect(events).toEqual([]);
  });

  test("session task_complete clears the in-memory active turn and returns to idle", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.status = "busy";
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleSessionLogLine(
      JSON.stringify({
        timestamp: "2026-03-23T10:00:00.000Z",
        payload: {
          type: "task_complete",
          turn_id: "turn_1",
          last_agent_message: "done",
        },
      }),
    );

    expect(adapter.activeTurn).toBeNull();
    expect(adapter.state.status).toBe("idle");
    expect(adapter.state.activeTurnId).toBeUndefined();
    expect(adapter.state.activeTurnOrigin).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "final_reply",
      "task_complete",
    ]);
  });

  test("flushes a complete final session line without a trailing newline", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.status = "busy";
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.sessionFinalText = "done";
    adapter.sessionPartialLine = JSON.stringify({
      timestamp: "2026-08-22T00:00:00.000Z",
      payload: {
        type: "task_complete",
        turn_id: "turn_1",
        last_agent_message: "done",
      },
    });

    adapter.flushCompleteSessionPartialLine();

    expect(adapter.sessionPartialLine).toBe("");
    expect(adapter.activeTurn).toBeNull();
    expect(adapter.state.status).toBe("idle");
    expect(adapter.hasCompletedTurn("turn_1")).toBe(true);
  });

  test("ignores late RPC notifications from an already completed turn", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "idle";
    adapter.rememberCompletedTurn("turn_done");

    adapter.handleRpcNotification("turn/started", {
      threadId: "thread_1",
      turnId: "turn_done",
    });

    expect(adapter.activeTurn).toBeNull();
    expect(adapter.state.status).toBe("idle");
    expect(events).toEqual([]);
  });

  test("sendInput recovers a stale hidden active turn before starting the next WeChat turn", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;

    adapter.nativeProcess = {};
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_stale",
      origin: "wechat",
    };
    adapter.state.status = "idle";
    adapter.state.activeTurnId = undefined;
    adapter.state.activeTurnOrigin = undefined;
    adapter.pendingTurnStart = false;
    adapter.pendingApproval = null;
    adapter.pendingApprovalRequests = [];
    adapter.ensureThreadStarted = async () => "thread_1";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("turn/start");
      return {
        turn: {
          id: "turn_2",
        },
      };
    };

    await adapter.sendInput("hello");

    expect(adapter.activeTurn).toEqual({
      threadId: "thread_1",
      turnId: "turn_2",
      origin: "wechat",
    });
    expect(adapter.state.activeTurnId).toBe("turn_2");
    expect(adapter.state.activeTurnOrigin).toBe("wechat");
  });

  test("sendInput subscribes the bridge before using a local-followed Codex thread", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];

    adapter.nativeProcess = {};
    adapter.sharedThreadId = "thread_local";
    adapter.state.sharedThreadId = "thread_local";
    adapter.state.sharedSessionId = "thread_local";
    adapter.state.status = "idle";
    adapter.pendingTurnStart = false;
    adapter.pendingApproval = null;
    adapter.pendingApprovalRequests = [];
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "thread/resume") {
        return {
          thread: {
            id: "thread_local",
          },
        };
      }
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_wechat",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    };

    await adapter.sendInput("hello from wechat");

    expect(requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    expect(requests[0]!.params).toMatchObject({
      threadId: "thread_local",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
    expect(requests[1]!.params).toMatchObject({
      threadId: "thread_local",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    expect(adapter.subscribedThreadIds.has("thread_local")).toBe(true);
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_local",
      turnId: "turn_wechat",
      origin: "wechat",
    });
  });

  test("sendInput keeps working when a local-followed Codex thread is not materialized yet", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let resumeAttempts = 0;

    adapter.nativeProcess = {};
    adapter.sharedThreadId = "thread_local";
    adapter.state.sharedThreadId = "thread_local";
    adapter.state.sharedSessionId = "thread_local";
    adapter.state.status = "idle";
    adapter.pendingTurnStart = false;
    adapter.pendingApproval = null;
    adapter.pendingApprovalRequests = [];
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "thread/resume") {
        resumeAttempts += 1;
        if (resumeAttempts === 1) {
          throw new Error("no rollout found for thread id thread_local");
        }
        return {
          thread: {
            id: "thread_local",
          },
        };
      }
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn_wechat",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    };

    await adapter.sendInput("hello from wechat");

    expect(requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/resume",
    ]);
    expect(adapter.subscribedThreadIds.has("thread_local")).toBe(true);
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_local",
      turnId: "turn_wechat",
      origin: "wechat",
    });
  });

  test("auto-denies Codex attempts to stage WeChat files in outbound directories", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.state.status = "busy";

    adapter.handleTrackedTurnServerRequest(
      7,
      "item/commandExecution/requestApproval",
      {
        command:
          'cp "C:/Users/unlin/Desktop/report.docx" "C:/Users/unlin/.cli-bridge/outbound-attachments/2026-05-23/report.docx"',
      },
      {
        threadId: "thread_1",
        turnId: "turn_1",
        origin: "wechat",
      },
    );

    expect(rpcMessages).toEqual([
      {
        id: 7,
        result: { decision: "decline" },
      },
    ]);
    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.state.pendingApproval).toBeUndefined();
    expect(adapter.state.status).toBe("busy");
  });

  test("auto-approves low-risk Codex command approvals without WeChat prompts", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.state.status = "busy";

    adapter.handleRpcServerRequest(
      11,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "call_1",
        command: "rg \"TODO\" src",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "cancel"],
      },
    );

    expect(rpcMessages).toEqual([
      {
        id: 11,
        result: { decision: "accept" },
      },
    ]);
    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.state.pendingApproval).toBeUndefined();
    expect(adapter.state.status).toBe("busy");
  });

  test("keeps high-risk Codex command approvals actionable through WeChat", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; request?: unknown }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string; request?: unknown }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.rpcSocket = {
      readyState: WebSocket.OPEN,
      send() {},
    };
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleRpcServerRequest(
      12,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "call_1",
        command: "Remove-Item -Recurse C:\\temp",
        cwd: "C:\\repo",
        availableDecisions: ["accept", "cancel"],
      },
    );

    expect(events.map((event) => event.type)).toEqual(["status", "approval_required"]);
    expect(adapter.pendingApprovalRequests).toMatchObject([{
      requestId: 12,
      method: "item/commandExecution/requestApproval",
    }]);
    expect(adapter.pendingApproval).toMatchObject({
      commandPreview: "Remove-Item -Recurse C:\\temp (C:\\repo)",
    });
    expect(rpcMessages).toEqual([]);
    expect(adapter.state.status).toBe("awaiting_approval");

    await expect(adapter.resolveApproval("confirm")).resolves.toBe(true);

    expect(rpcMessages).toEqual([
      {
        id: 12,
        result: { decision: "accept" },
      },
    ]);
    expect(adapter.pendingApprovalRequests).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.state.status).toBe("busy");
  });

  test("auto-denies Codex outbound attachment permission requests", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleRpcServerRequest(
      8,
      "item/permissions/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "call_1",
        cwd: "C:\\repo",
        reason: "Select a workspace root",
        permissions: {
          fileSystem: {
            read: null,
            write: [
              "C:\\Users\\unlin\\.cli-bridge\\outbound-attachments\\2026-05-23",
            ],
          },
        },
      },
    );

    expect(rpcMessages).toEqual([
      {
        id: 8,
        result: {
          permissions: {},
          scope: "turn",
        },
      },
    ]);
    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.state.pendingApproval).toBeUndefined();
    expect(adapter.state.status).toBe("busy");
  });

  test("auto-approves low-risk Codex permissions with strict auto review", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleRpcServerRequest(
      13,
      "item/permissions/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "call_1",
        cwd: "C:\\repo",
        reason: "Need generated asset access.",
        permissions: {
          network: {
            enabled: true,
          },
          fileSystem: {
            read: null,
            write: ["C:\\repo\\generated"],
          },
        },
      },
    );

    expect(rpcMessages).toEqual([
      {
        id: 13,
        result: {
          permissions: {
            network: {
              enabled: true,
            },
            fileSystem: {
              read: null,
              write: ["C:\\repo\\generated"],
            },
          },
          scope: "turn",
          strictAutoReview: true,
        },
      },
    ]);
    expect(events.filter((event) => event.type === "approval_required")).toEqual([]);
    expect(adapter.pendingApprovalRequests).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.state.pendingApproval).toBeUndefined();
    expect(adapter.state.status).toBe("busy");
  });

  test("emits high-risk Codex permissions approvals and grants requested permissions on confirm", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; request?: unknown }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string; request?: unknown }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.rpcSocket = {
      readyState: WebSocket.OPEN,
      send() {},
    };
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleRpcServerRequest(
      9,
      "item/permissions/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "call_1",
        cwd: "C:\\repo",
        reason: "Need system access.",
        permissions: {
          network: {
            enabled: true,
          },
          fileSystem: {
            read: null,
            write: ["C:\\Windows\\System32"],
          },
        },
      },
    );

    expect(events.map((event) => event.type)).toEqual(["status", "approval_required"]);
    expect(adapter.pendingApprovalRequests).toMatchObject([{
      requestId: 9,
      method: "item/permissions/requestApproval",
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    }]);
    expect(adapter.pendingApproval).toMatchObject({
      summary:
        "Codex needs approval before granting extra permissions: Need system access.",
      commandPreview: "network access; write: C:\\Windows\\System32",
    });
    expect(adapter.state.status).toBe("awaiting_approval");

    await expect(adapter.resolveApproval("confirm")).resolves.toBe(true);

    expect(rpcMessages).toEqual([
      {
        id: 9,
        result: {
          permissions: {
            network: {
              enabled: true,
            },
            fileSystem: {
              read: null,
              write: ["C:\\Windows\\System32"],
            },
          },
          scope: "turn",
        },
      },
    ]);
    expect(adapter.pendingApprovalRequests).toEqual([]);
    expect(adapter.pendingApproval).toBeNull();
    expect(adapter.state.pendingApproval).toBeNull();
    expect(adapter.state.status).toBe("busy");
  });

  test("returns explicit fallback responses for unsupported Codex server tools", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };

    adapter.handleRpcServerRequest(10, "mcpServer/elicitation/request", {
      threadId: "thread_1",
      turnId: "turn_1",
      serverName: "calendar",
      mode: "form",
      message: "Allow this request?",
      requestedSchema: {
        type: "object",
        properties: {},
      },
    });
    adapter.handleRpcServerRequest(11, "item/tool/call", {
      threadId: "thread_1",
      turnId: "turn_1",
      callId: "call_1",
      tool: "lookup_ticket",
      arguments: {},
    });

    expect(rpcMessages).toEqual([
      {
        id: 10,
        result: {
          action: "decline",
          content: null,
          _meta: null,
        },
      },
      {
        id: 11,
        result: {
          contentItems: [
            {
              type: "inputText",
              text: "Dynamic tool calls are not supported by the WeChat bridge.",
            },
          ],
          success: false,
        },
      },
    ]);
  });

  test("answers Codex currentTime/read requests with whole Unix seconds", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const rpcMessages: Array<Record<string, unknown>> = [];
    const before = Math.floor(Date.now() / 1_000);
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };

    adapter.handleRpcServerRequest(12, "currentTime/read", {
      threadId: "thread_1",
    });

    const after = Math.floor(Date.now() / 1_000);
    expect(rpcMessages).toHaveLength(1);
    expect(rpcMessages[0]?.id).toBe(12);
    const currentTimeAt = (rpcMessages[0]?.result as { currentTimeAt: number }).currentTimeAt;
    expect(Number.isInteger(currentTimeAt)).toBe(true);
    expect(currentTimeAt).toBeGreaterThanOrEqual(before);
    expect(currentTimeAt).toBeLessThanOrEqual(after);
  });

  test("uses current Codex initialize and thread-start fields", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return method === "thread/start" ? { thread: { id: "thread_current" } } : {};
    };

    await adapter.initializeRpcClient();
    await expect(adapter.ensureThreadStarted()).resolves.toBe("thread_current");

    expect(requests[0]).toMatchObject({
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    expect(requests[1]).toEqual({
      method: "thread/start",
      params: {
        cwd: process.cwd(),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        serviceName: "wechat-bridge",
      },
    });
  });

  test("emits Codex user input requests and submits answers back to app-server", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; request?: unknown }> = [];
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: { type: string; request?: unknown }) => events.push(event));
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleRpcServerRequest(
      9,
      "item/tool/requestUserInput",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "call_1",
        questions: [
          {
            id: "format",
            header: "Format",
            question: "Which output format should I use?",
            options: [
              {
                label: "Markdown",
                description: "Return Markdown.",
              },
            ],
          },
        ],
      },
    );

    expect(events.map((event) => event.type)).toEqual([
      "status",
      "user_input_required",
    ]);
    expect(adapter.pendingUserInputRequest).toEqual({
      requestId: 9,
      method: "item/tool/requestUserInput",
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
      isBlocking: true,
    });
    expect(adapter.state.status).toBe("awaiting_input");
    expect(adapter.state.pendingUserInputOrigin).toBe("wechat");
    expect(adapter.state.pendingUserInput).toMatchObject({
      questions: [
        {
          id: "format",
          header: "Format",
        },
      ],
    });

    await expect(adapter.submitUserInput({ format: ["Markdown"] })).resolves.toBe(true);

    expect(rpcMessages).toEqual([
      {
        id: 9,
        result: {
          answers: {
            format: {
              answers: ["Markdown"],
            },
          },
        },
      },
    ]);
    expect(adapter.pendingUserInputRequest).toBeNull();
    expect(adapter.state.pendingUserInput).toBeNull();
    expect(adapter.state.pendingUserInputOrigin).toBeUndefined();
    expect(adapter.state.status).toBe("busy");
  });

  test("clears Codex user input state when the server resolves the request", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string }> = [];
    adapter.setEventSink((event: { type: string }) => events.push(event));
    adapter.pendingUserInputRequest = {
      requestId: 10,
      method: "item/tool/requestUserInput",
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.pendingUserInput = {
      summary: "Codex needs more information before the tool can continue.",
      questions: [
        {
          id: "format",
          header: "Format",
          question: "Which output format should I use?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
    };
    adapter.state.pendingUserInputOrigin = "wechat";
    adapter.state.status = "awaiting_input";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };

    adapter.handleRpcNotification("serverRequest/resolved", {
      threadId: "thread_1",
      turnId: "turn_1",
      requestId: 10,
    });

    expect(adapter.pendingUserInputRequest).toBeNull();
    expect(adapter.state.pendingUserInput).toBeNull();
    expect(adapter.state.pendingUserInputOrigin).toBeUndefined();
    expect(adapter.state.status).toBe("busy");
    expect(events.map((event) => event.type)).toEqual(["status"]);
  });

  test("auto-resolves non-blocking Codex user input after the compatibility timeout", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const rpcMessages: Array<Record<string, unknown>> = [];
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.userInputAutoResolutionDelayMs = 10;
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_1";
    adapter.state.activeTurnOrigin = "wechat";

    adapter.handleRpcServerRequest(13, "item/tool/requestUserInput", {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "call_1",
      isBlocking: false,
      questions: [
        {
          id: "optional_context",
          header: "Context",
          question: "Add optional context?",
          options: null,
        },
      ],
    });

    expect(adapter.pendingUserInputRequest?.isBlocking).toBe(false);
    await wait(30);

    expect(rpcMessages).toEqual([
      {
        id: 13,
        result: {
          answers: {},
        },
      },
    ]);
    expect(adapter.pendingUserInputRequest).toBeNull();
    expect(adapter.state.pendingUserInput).toBeNull();
    expect(adapter.state.status).toBe("busy");
  });

  test("mirrors the first local turn after /resume before shared thread follow catches up", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; text?: string; threadId?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; threadId?: string }) =>
      events.push(event),
    );
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.status = "idle";

    adapter.handleRpcNotification("turn/started", {
      threadId: "thread_new",
      turnId: "turn_local_1",
    });
    adapter.handleRpcNotification("item/started", {
      threadId: "thread_new",
      turnId: "turn_local_1",
      item: {
        type: "userMessage",
        id: "item_1",
        content: [
          {
            type: "text",
            text: "First local turn after /resume",
            text_elements: [],
          },
        ],
      },
    });

    expect(adapter.activeTurn).toEqual({
      threadId: "thread_new",
      turnId: "turn_local_1",
      origin: "local",
    });
    expect(
      events
        .filter((event) => event.type === "thread_switched" || event.type === "mirrored_user_input")
        .map((event) =>
          event.type === "thread_switched"
            ? { type: event.type, threadId: event.threadId }
            : { type: event.type, text: event.text },
        ),
    ).toEqual([
      {
        type: "thread_switched",
        threadId: "thread_new",
      },
      {
        type: "mirrored_user_input",
        text: "First local turn after /resume",
      },
    ]);
  });

  test("mirrors the first local turn during startup before any shared thread is established", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; text?: string; threadId?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; threadId?: string }) =>
      events.push(event),
    );
    adapter.state.status = "idle";

    adapter.handleRpcNotification("item/started", {
      threadId: "thread_bootstrap_1",
      turnId: "turn_local_bootstrap_1",
      item: {
        type: "userMessage",
        id: "item_bootstrap_1",
        content: [
          {
            type: "text",
            text: "First local turn after bridge startup",
            text_elements: [],
          },
        ],
      },
    });
    adapter.handleRpcNotification("turn/started", {
      threadId: "thread_bootstrap_1",
      turnId: "turn_local_bootstrap_1",
    });

    expect(adapter.activeTurn).toEqual({
      threadId: "thread_bootstrap_1",
      turnId: "turn_local_bootstrap_1",
      origin: "local",
    });
    expect(
      events
        .filter((event) => event.type === "thread_switched" || event.type === "mirrored_user_input")
        .map((event) =>
          event.type === "thread_switched"
            ? { type: event.type, threadId: event.threadId }
            : { type: event.type, text: event.text },
        ),
    ).toEqual([
      {
        type: "thread_switched",
        threadId: "thread_bootstrap_1",
      },
      {
        type: "mirrored_user_input",
        text: "First local turn after bridge startup",
      },
    ]);
  });

  test("mirrors the first local turn after /resume even when item/started arrives before turn/started", () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; text?: string; threadId?: string }> = [];
    adapter.setEventSink((event: { type: string; text?: string; threadId?: string }) =>
      events.push(event),
    );
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.status = "idle";

    adapter.handleRpcNotification("item/started", {
      threadId: "thread_newer",
      turnId: "turn_local_newer",
      item: {
        type: "userMessage",
        id: "item_newer",
        content: [
          {
            type: "text",
            text: "First local turn after /resume with item first",
            text_elements: [],
          },
        ],
      },
    });
    adapter.handleRpcNotification("turn/started", {
      threadId: "thread_newer",
      turnId: "turn_local_newer",
    });

    expect(adapter.activeTurn).toEqual({
      threadId: "thread_newer",
      turnId: "turn_local_newer",
      origin: "local",
    });
    expect(
      events
        .filter((event) => event.type === "thread_switched" || event.type === "mirrored_user_input")
        .map((event) =>
          event.type === "thread_switched"
            ? { type: event.type, threadId: event.threadId }
            : { type: event.type, text: event.text },
        ),
    ).toEqual([
      {
        type: "thread_switched",
        threadId: "thread_newer",
      },
      {
        type: "mirrored_user_input",
        text: "First local turn after /resume with item first",
      },
    ]);
  });

  test("announces the startup thread after the local follow candidate settles", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; threadId?: string }> = [];
    adapter.setEventSink((event: { type: string; threadId?: string }) => events.push(event));
    adapter.state.status = "idle";

    adapter.handleRpcNotification("thread/status/changed", {
      threadId: "thread_settle_1",
      status: {
        type: "idle",
      },
    });

    await wait(220);

    expect(
      events
        .filter((event) => event.type === "thread_switched")
        .map((event) => ({ type: event.type, threadId: event.threadId })),
    ).toEqual([
      {
        type: "thread_switched",
        threadId: "thread_settle_1",
      },
    ]);
  });

  test("only announces the latest startup thread candidate when the first one is replaced", async () => {
    const adapter = createBridgeAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; threadId?: string }> = [];
    adapter.setEventSink((event: { type: string; threadId?: string }) => events.push(event));
    adapter.state.status = "idle";

    adapter.handleRpcNotification("thread/status/changed", {
      threadId: "thread_stale_candidate",
      status: {
        type: "idle",
      },
    });
    await wait(40);
    adapter.handleRpcNotification("thread/status/changed", {
      threadId: "thread_final_candidate",
      status: {
        type: "idle",
      },
    });

    await wait(220);

    expect(
      events
        .filter((event) => event.type === "thread_switched")
        .map((event) => ({ type: event.type, threadId: event.threadId })),
    ).toEqual([
      {
        type: "thread_switched",
        threadId: "thread_final_candidate",
      },
    ]);
  });
});

describe("findRecentCodexSessionFileForCwd", () => {
  test("finds a recently updated historical thread for the current cwd", () => {
    const homeDirectory = makeTempDirectory();
    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;

    const cwd = "C:\\repo";
    const sessionFilePath = path.join(
      homeDirectory,
      ".codex",
      "sessions",
      "2025",
      "12",
      "31",
      "historical-thread.jsonl",
    );
    writeTextFile(
      sessionFilePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread_historical_123",
            cwd,
            source: "cli",
            timestamp: "2025-12-31T10:00:00.000Z",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Resume this old thread.",
          },
          timestamp: "2026-03-23T12:00:01.000Z",
        }),
      ].join("\n"),
    );
    const freshMtime = new Date("2026-03-23T12:00:05.000Z");
    fs.utimesSync(sessionFilePath, freshMtime, freshMtime);

    const recent = findRecentCodexSessionFileForCwd(cwd, Date.parse("2026-03-23T12:00:00.000Z"));

    expect(recent).not.toBeNull();
    expect(recent?.threadId).toBe("thread_historical_123");
    expect(recent?.filePath).toBe(sessionFilePath);
  });

  test("only accepts trusted CLI or wechat-bridge vscode sessions for recent fallback", () => {
    const homeDirectory = makeTempDirectory();
    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;

    const cwd = "C:\\repo";
    const desktopSessionPath = path.join(
      homeDirectory,
      ".codex",
      "sessions",
      "2026",
      "03",
      "23",
      "desktop-thread.jsonl",
    );
    const bridgeSessionPath = path.join(
      homeDirectory,
      ".codex",
      "sessions",
      "2026",
      "03",
      "23",
      "bridge-thread.jsonl",
    );
    const foreignVscodeSessionPath = path.join(
      homeDirectory,
      ".codex",
      "sessions",
      "2026",
      "03",
      "23",
      "foreign-vscode-thread.jsonl",
    );

    writeTextFile(
      desktopSessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread_desktop",
            cwd,
            source: "vscode",
            originator: "Codex Desktop",
            timestamp: "2026-03-23T12:00:00.000Z",
          },
        }),
      ].join("\n"),
    );
    const desktopMtime = new Date("2026-03-23T12:00:08.000Z");
    fs.utimesSync(desktopSessionPath, desktopMtime, desktopMtime);

    writeTextFile(
      foreignVscodeSessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread_foreign_vscode",
            cwd,
            source: "vscode",
            originator: "Some Other Integration",
            timestamp: "2026-03-23T12:00:00.500Z",
          },
        }),
      ].join("\n"),
    );
    const foreignMtime = new Date("2026-03-23T12:00:09.000Z");
    fs.utimesSync(foreignVscodeSessionPath, foreignMtime, foreignMtime);

    writeTextFile(
      bridgeSessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "thread_bridge",
            cwd,
            source: "vscode",
            originator: "wechat-bridge",
            timestamp: "2026-03-23T12:00:01.000Z",
          },
        }),
      ].join("\n"),
    );
    const bridgeMtime = new Date("2026-03-23T12:00:05.000Z");
    fs.utimesSync(bridgeSessionPath, bridgeMtime, bridgeMtime);

    const recent = findRecentCodexSessionFileForCwd(cwd, Date.parse("2026-03-23T12:00:00.000Z"));

    expect(recent).not.toBeNull();
    expect(recent?.threadId).toBe("thread_bridge");
    expect(recent?.filePath).toBe(bridgeSessionPath);
  });
});

describe("extractCodexFinalTextFromItem", () => {
  test("returns only final-answer agent messages", () => {
    expect(
      extractCodexFinalTextFromItem({
        type: "agentMessage",
        id: "msg_1",
        phase: "final_answer",
        text: "Final reply",
      }),
    ).toBe("Final reply");
  });

  test("ignores commentary and non-agent items", () => {
    expect(
      extractCodexFinalTextFromItem({
        type: "agentMessage",
        id: "msg_2",
        phase: "commentary",
        text: "Thinking...",
      }),
    ).toBeNull();

    expect(
      extractCodexFinalTextFromItem({
        type: "commandExecution",
        id: "cmd_1",
      }),
    ).toBeNull();
  });
});

describe("extractCodexUserMessageText", () => {
  test("extracts plain text user input", () => {
    expect(
      extractCodexUserMessageText({
        type: "userMessage",
        id: "msg_1",
        content: [
          {
            type: "text",
            text: "List the files in this directory.",
            text_elements: [],
          },
        ],
      }),
    ).toBe("List the files in this directory.");
  });

  test("summarizes non-text inputs for mirrored local prompts", () => {
    expect(
      extractCodexUserMessageText({
        type: "userMessage",
        id: "msg_2",
        content: [
          {
            type: "mention",
            name: "repo",
            path: "app://repo",
          },
          {
            type: "localImage",
            path: "C:\\repo\\diagram.png",
          },
        ],
      }),
    ).toBe("[mention: repo]\n[local image: C:\\repo\\diagram.png]");
  });
});

describe("listCodexResumeThreads", () => {
  test("lists the latest saved threads for the current working directory", () => {
    const homeDirectory = makeTempDirectory();
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;

    try {
      const sessionsRoot = path.join(homeDirectory, ".codex", "sessions", "2026", "03", "23");
      const repoCwd = "C:\\repo";
      const otherCwd = "C:\\other";

      writeTextFile(
        path.join(sessionsRoot, "thread-a.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-23T10:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread_a",
              timestamp: "2026-03-23T10:00:00.000Z",
              cwd: repoCwd,
              source: "cli",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-23T10:01:00.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Inspect the current bridge implementation.",
            },
          }),
        ].join("\n"),
      );

      writeTextFile(
        path.join(sessionsRoot, "thread-b.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-23T11:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread_b",
              timestamp: "2026-03-23T11:00:00.000Z",
              cwd: repoCwd,
              source: "cli",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-23T11:02:00.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Resume the latest saved thread.",
            },
          }),
        ].join("\n"),
      );

      writeTextFile(
        path.join(sessionsRoot, "thread-other.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-03-23T12:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "thread_other",
              timestamp: "2026-03-23T12:00:00.000Z",
              cwd: otherCwd,
              source: "cli",
            },
          }),
        ].join("\n"),
      );

      const candidates = listCodexResumeThreads(repoCwd, 10);
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.sessionId).toBe("thread_b");
      expect(candidates[0]?.threadId).toBe("thread_b");
      expect(candidates[0]?.title).toContain("Resume the latest saved thread");
      expect(candidates[1]?.sessionId).toBe("thread_a");
      expect(candidates[1]?.threadId).toBe("thread_a");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
});
