import { describe, expect, test } from "bun:test";

import {
  isOpencodeAttachCommandLine,
  isOpencodeServeCommandLine,
  isWechatBridgeCommandLine,
  isWechatDaemonCommandLine,
  isWechatDaemonCommandLineForCwd,
  parsePosixBridgeProcessProbeOutput,
  parseWindowsBridgeProcessProbeOutput,
} from "../../src/bridge/bridge-process-reaper.ts";

describe("bridge peer process reaper", () => {
  test("detects wechat-bridge command lines", () => {
    expect(
      isWechatBridgeCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter opencode --cwd C:\\Users\\unlin',
      ),
    ).toBe(true);
    expect(
      isWechatBridgeCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\unlin\\AppData\\Roaming\\npm\\node_modules\\cli-wechat-bridge\\dist\\bridge\\wechat-bridge.js" "--adapter" "codex"',
      ),
    ).toBe(true);
    expect(
      isWechatBridgeCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\companion\\local-companion-start.ts --adapter opencode',
      ),
    ).toBe(false);
  });

  test("detects wechat-daemon command lines", () => {
    expect(
      isWechatDaemonCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\daemon\\wechat-daemon.ts --cwd C:\\repo',
      ),
    ).toBe(true);
    expect(
      isWechatDaemonCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\unlin\\AppData\\Roaming\\npm\\node_modules\\cli-wechat-bridge\\dist\\daemon\\wechat-daemon.js"',
      ),
    ).toBe(true);
    expect(
      isWechatDaemonCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter codex',
      ),
    ).toBe(false);
  });

  test("matches wechat-daemon command lines for a startup cwd", () => {
    expect(
      isWechatDaemonCommandLineForCwd(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\unlin\\AppData\\Roaming\\npm\\node_modules\\cli-wechat-bridge\\bin\\wechat-daemon.mjs" "--cwd" "C:\\Users\\unlin"',
        "C:\\Users\\unlin",
      ),
    ).toBe(true);

    expect(
      isWechatDaemonCommandLineForCwd(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\dist\\daemon\\wechat-daemon.js --cwd=C:\\Users\\unlin',
        "C:\\Users\\unlin",
      ),
    ).toBe(true);

    expect(
      isWechatDaemonCommandLineForCwd(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\dist\\daemon\\wechat-daemon.js --cwd C:\\Users\\other',
        "C:\\Users\\unlin",
      ),
    ).toBe(false);

    expect(
      isWechatDaemonCommandLineForCwd(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter codex --cwd C:\\Users\\unlin',
        "C:\\Users\\unlin",
      ),
    ).toBe(false);
  });

  test("detects opencode serve command lines", () => {
    expect(isOpencodeServeCommandLine("opencode serve --port 12345 --hostname 127.0.0.1")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode.exe serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode.cmd serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode.bat serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("/usr/local/bin/opencode serve --port 12345")).toBe(true);
    expect(isOpencodeServeCommandLine("opencode chat")).toBe(false);
    expect(isOpencodeServeCommandLine("node server.js --port 12345")).toBe(false);
    expect(isOpencodeServeCommandLine("")).toBe(false);
  });

  test("detects opencode attach command lines", () => {
    expect(isOpencodeAttachCommandLine("opencode attach http://127.0.0.1:12345")).toBe(true);
    expect(
      isOpencodeAttachCommandLine("opencode.exe attach http://127.0.0.1:12345 --session ses_123"),
    ).toBe(true);
    expect(
      isOpencodeAttachCommandLine("opencode.cmd attach http://127.0.0.1:12345 --session 019d2ebf"),
    ).toBe(true);
    expect(isOpencodeAttachCommandLine("/usr/local/bin/opencode attach http://127.0.0.1:12345")).toBe(true);
    expect(isOpencodeAttachCommandLine("opencode serve --port 12345")).toBe(false);
    expect(isOpencodeAttachCommandLine("node attach.js http://127.0.0.1:12345")).toBe(false);
    expect(isOpencodeAttachCommandLine("")).toBe(false);
  });

  test("parses Windows process probe output and filters non-bridge rows", () => {
    const output = JSON.stringify([
      {
        ProcessId: 101,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter opencode --cwd C:\\Users\\unlin',
      },
      {
        ProcessId: 202,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\companion\\local-companion-start.ts --adapter opencode',
      },
      {
        ProcessId: 204,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\unlin\\AppData\\Roaming\\npm\\node_modules\\cli-wechat-bridge\\dist\\bridge\\wechat-bridge.js" "--adapter" "codex"',
      },
      {
        ProcessId: 303,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter codex --cwd C:\\repo',
      },
    ]);

    expect(parseWindowsBridgeProcessProbeOutput(output, 303)).toEqual([
      {
        pid: 101,
        parentPid: 1,
        name: "node.exe",
        commandLine:
          '"C:\\Program Files\\nodejs\\node.exe" --no-warnings --experimental-strip-types C:\\repo\\src\\bridge\\wechat-bridge.ts --adapter opencode --cwd C:\\Users\\unlin',
      },
      {
        pid: 204,
        parentPid: 1,
        name: "node.exe",
        commandLine:
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\unlin\\AppData\\Roaming\\npm\\node_modules\\cli-wechat-bridge\\dist\\bridge\\wechat-bridge.js" "--adapter" "codex"',
      },
    ]);
  });

  test("parses POSIX process probe output and ignores the current pid", () => {
    const output = [
      '101 node --no-warnings --experimental-strip-types /repo/src/bridge/wechat-bridge.ts --adapter opencode --cwd /tmp/work',
      '202 node --no-warnings --experimental-strip-types /repo/src/companion/local-companion-start.ts --adapter opencode',
      '303 node --no-warnings --experimental-strip-types /repo/src/bridge/wechat-bridge.ts --adapter codex --cwd /repo',
    ].join("\n");

    expect(parsePosixBridgeProcessProbeOutput(output, 303)).toEqual([
      {
        pid: 101,
        commandLine:
          'node --no-warnings --experimental-strip-types /repo/src/bridge/wechat-bridge.ts --adapter opencode --cwd /tmp/work',
      },
    ]);
  });
});
