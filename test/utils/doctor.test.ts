import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { BridgeLockPayload } from "../../src/bridge/bridge-state.ts";
import type { LocalCompanionEndpoint } from "../../src/companion/local-companion-link.ts";
import type { DaemonEndpoint } from "../../src/daemon/daemon-link.ts";
import { setLocale } from "../../src/i18n/index.ts";
import {
  buildDoctorReport,
  parseDoctorCliArgs,
  type DoctorDeps,
} from "../../src/utils/doctor.ts";

const DATA_DIR = "D:\\bridge-data";
const CWD = "D:\\work\\project";

afterEach(() => {
  setLocale("zh");
});

function buildLock(overrides: Partial<BridgeLockPayload> = {}): BridgeLockPayload {
  return {
    pid: 100,
    parentPid: 50,
    instanceId: "bridge-lock",
    adapter: "codex",
    command: "codex",
    cwd: CWD,
    startedAt: "2026-06-01T00:00:00.000Z",
    lifecycle: "persistent",
    ...overrides,
  };
}

function buildDaemonEndpoint(
  overrides: Partial<DaemonEndpoint> = {},
): DaemonEndpoint {
  return {
    protocolVersion: 1,
    pid: 200,
    port: 50123,
    token: "daemon-token",
    cwd: CWD,
    startedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildLocalEndpoint(
  overrides: Partial<LocalCompanionEndpoint> = {},
): LocalCompanionEndpoint {
  return {
    protocolVersion: 2,
    runtimeKind: "codex_runtime_host",
    instanceId: "bridge-lock",
    kind: "codex",
    port: 51234,
    token: "local-token",
    cwd: CWD,
    command: "codex",
    startedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(options: {
  files?: Record<string, unknown>;
  alivePids?: number[];
  daemonAlive?: boolean;
  endpoint?: LocalCompanionEndpoint | null;
  legacyEndpoint?: LocalCompanionEndpoint | null;
  reachablePorts?: number[];
  codePage?: number | null;
  serverDate?: Date | null;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
} = {}): DoctorDeps {
  const dataDir = options.dataDir ?? DATA_DIR;
  const files = new Map<string, string>();
  for (const [name, value] of Object.entries(options.files ?? {})) {
    files.set(path.join(dataDir, name), JSON.stringify(value));
  }
  const alivePids = new Set(options.alivePids ?? []);
  const reachablePorts = new Set(options.reachablePorts ?? []);
  const nowMs = options.nowMs ?? Date.parse("2026-06-01T00:00:00.000Z");

  return {
    platform: "win32",
    arch: "x64",
    nodeVersion: "v24.0.0",
    osRelease: () => "10.0.26200",
    env: options.env ?? {},
    now: () => nowMs,
    getWindowsCodePage: () => options.codePage ?? 65001,
    fetchServerDate: async () =>
      options.serverDate === undefined ? new Date(nowMs) : options.serverDate,
    findExecutable: (name) => `C:\\bin\\${name}.cmd`,
    loadNodePty: async () => undefined,
    resolveDataDir: () => dataDir,
    exists: (filePath) => filePath === dataDir ||
      filePath === path.join(dataDir, "account.json") ||
      files.has(filePath),
    readTextFile: (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error(`missing test file: ${filePath}`);
      }
      return content;
    },
    isProcessAlive: (pid) => alivePids.has(pid),
    isTcpPortReachable: async (port) => reachablePorts.has(port),
    isDaemonAlive: async () => options.daemonAlive ?? false,
    readLocalCompanionEndpoint: (_cwd, adapter) => {
      if (!adapter) {
        return options.legacyEndpoint ?? null;
      }
      return options.endpoint ?? null;
    },
  };
}

describe("doctor report", () => {
  test("parseDoctorCliArgs reads injected adapter and cwd", () => {
    const parsed = parseDoctorCliArgs(
      ["--adapter", "codex", "--doctor", "--cwd", ".\\tmp\\project"],
      "bridge",
      CWD,
    );

    expect(parsed).toEqual({
      mode: "bridge",
      cwd: path.resolve(".\\tmp\\project"),
      adapter: "codex",
    });
  });

  test("reports clean runtime state in default Chinese locale", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps(),
    );
    const output = lines.join("\n");

    expect(output).toContain("CLI WeChat Bridge 诊断");
    expect(output).toContain("\n环境\n");
    expect(output).toContain("\n适配器命令\n");
    expect(output).toContain("\n数据\n");
    expect(output).toContain("\n运行时\n");
    expect(output).toContain("Codex CLI");
    expect(output).not.toContain("Claude CLI");
    expect(output).not.toContain("OpenCode");
    expect(output).toContain("  [ok] 守护进程 无");
    expect(output).toContain("  [ok] 桥接锁 无");
    expect(output).toContain("  [ok] 工作区端点 (codex) 无");
    expect(output).toContain("  [ok] 旧端点 无");
    expect(output).not.toContain("Runtime");
    expect(output).not.toContain(" / ");
  });

  test("reports live daemon as a standalone bridge startup blocker", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps({
        files: {
          "daemon-endpoint.json": buildDaemonEndpoint(),
        },
        alivePids: [200],
        daemonAlive: true,
      }),
    );
    const output = lines.join("\n");

    expect(output).toContain("  [fail] 守护进程 运行中 pid=200");
    expect(output).toContain("独立桥接会拒绝启动");
  });

  test("classifies stale and reclaimable bridge locks", async () => {
    const stale = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps({
        files: {
          "bridge.lock.json": buildLock(),
        },
      }),
    );

    const staleOutput = stale.join("\n");
    expect(staleOutput).toContain("  [warn] 桥接锁 过期");
    expect(stale).toContain("    pid 100");
    expect(stale).toContain("    适配器 codex");
    expect(stale).toContain("    目录 D:\\work\\project");
    expect(stale).toContain("    生命周期 persistent");
    expect(stale).toContain("    启动时间 2026-06-01T00:00:00.000Z");
    expect(staleOutput).not.toContain("pid=100 adapter=codex");

    const reclaimable = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps({
        files: {
          "bridge.lock.json": buildLock({
            lifecycle: "companion_bound",
          }),
        },
        alivePids: [100],
      }),
    );

    const reclaimableOutput = reclaimable.join("\n");
    expect(reclaimableOutput).toContain("  [warn] 桥接锁 可回收");
    expect(reclaimable).toContain("    pid 100");
    expect(reclaimable).toContain("    适配器 codex");
    expect(reclaimable).toContain("    生命周期 companion_bound");
    expect(reclaimable).toContain("    父进程 pid=50 alive=否");
    expect(reclaimableOutput).not.toContain("pid=100 adapter=codex");
  });

  test("reports live bridge lock conflict for standalone bridge", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps({
        files: {
          "bridge.lock.json": buildLock(),
        },
        alivePids: [100, 50],
      }),
    );
    const output = lines.join("\n");

    expect(output).toContain("  [fail] 桥接锁 运行中");
    expect(lines).toContain("    pid 100");
    expect(lines).toContain("    适配器 codex");
    expect(output).not.toContain("pid=100 adapter=codex");
    expect(output).toContain("独立桥接会因锁冲突启动失败");
  });

  test("reports endpoint reachability and ownership problems", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps({
        files: {
          "bridge.lock.json": buildLock({
            instanceId: "bridge-lock",
          }),
        },
        alivePids: [100],
        endpoint: buildLocalEndpoint({
          instanceId: "bridge-endpoint",
          bridgeOwnerPid: 333,
          companionPid: 444,
          companionStatus: "stopped",
        }),
      }),
    );
    const output = lines.join("\n");

    expect(output).toContain("  [warn] 工作区端点 (codex) 实例=bridge-endpoint");
    expect(output).toContain("端点端口 51234 不可达");
    expect(output).toContain("桥接 owner pid=333 已退出");
    expect(output).toContain("companion pid=444 已退出");
    expect(output).toContain("可见端 worker 状态=stopped");
    expect(output).toContain("端点 instanceId 与桥接锁 instanceId 不一致");
  });

  test("reports daemon startup will stop a live single bridge", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor"],
        mode: "daemon",
        cwd: CWD,
      },
      makeDeps({
        files: {
          "bridge.lock.json": buildLock({
            adapter: "opencode",
          }),
        },
        alivePids: [100, 50],
      }),
    );
    const output = lines.join("\n");

    expect(output).toContain("  [warn] 桥接锁 运行中");
    expect(lines).toContain("    pid 100");
    expect(lines).toContain("    适配器 opencode");
    expect(output).not.toContain("pid=100 adapter=opencode");
    expect(output).toContain("守护进程启动会先停止这个单桥接");
    expect(output).toContain("  [ok] 工作区端点 (opencode) 无");
  });

  test("daemon doctor keeps all adapter CLI checks", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor"],
        mode: "daemon",
        cwd: CWD,
      },
      makeDeps(),
    );
    const output = lines.join("\n");

    expect(output).toContain("Codex CLI");
    expect(output).toContain("Claude CLI");
    expect(output).toContain("OpenCode");
    expect(output).toContain("Pi");
  });

  test("shell bridge doctor skips agent CLI checks", async () => {
    const lines = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "shell"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps(),
    );
    const output = lines.join("\n");

    expect(output).toContain("  [ok] shell 使用本机 shell");
    expect(output).not.toContain("Codex CLI");
    expect(output).not.toContain("Claude CLI");
    expect(output).not.toContain("OpenCode");
    expect(output).not.toContain("Pi");
  });

  test("English locale uses English-only doctor labels", async () => {
    setLocale("en");

    const lines = await buildDoctorReport(
      {
        argv: ["--doctor", "--adapter", "codex"],
        mode: "bridge",
        cwd: CWD,
      },
      makeDeps(),
    );
    const output = lines.join("\n");

    expect(output).toContain("CLI WeChat Bridge Doctor");
    expect(output).toContain("\nRuntime\n");
    expect(output).toContain("  [ok] Daemon none");
    expect(output).toContain("  [ok] Workspace endpoint (codex) none");
    expect(output).not.toContain("诊断");
    expect(output).not.toContain("运行时");
    expect(output).not.toContain("守护进程");
    expect(output).not.toContain(" / ");
  });

  test("warns when the console code page is non-UTF8 and the data dir has non-ASCII characters", async () => {
    const risky = await buildDoctorReport(
      { argv: [], mode: "bridge", cwd: CWD },
      makeDeps({ codePage: 936, dataDir: "C:\\Users\\张三\\.cli-bridge" }),
    );
    expect(risky.join("\n")).toContain("[warn] 控制台代码页");

    const safe = await buildDoctorReport(
      { argv: [], mode: "bridge", cwd: CWD },
      makeDeps({ codePage: 936 }),
    );
    expect(safe.join("\n")).toContain("[ok] 控制台代码页 936");
  });

  test("warns on large clock skew against the server date", async () => {
    const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
    const skewed = await buildDoctorReport(
      { argv: [], mode: "bridge", cwd: CWD },
      makeDeps({ nowMs, serverDate: new Date(nowMs - 120_000) }),
    );
    expect(skewed.join("\n")).toContain("[warn] 系统时钟");

    const aligned = await buildDoctorReport(
      { argv: [], mode: "bridge", cwd: CWD },
      makeDeps({ nowMs, serverDate: new Date(nowMs - 2_000) }),
    );
    expect(aligned.join("\n")).toContain("[ok] 系统时钟");
  });

  test("suggests NODE_USE_ENV_PROXY when the server is unreachable behind a proxy", async () => {
    const lines = await buildDoctorReport(
      { argv: [], mode: "bridge", cwd: CWD },
      makeDeps({
        serverDate: null,
        env: { HTTPS_PROXY: "http://127.0.0.1:7890" },
      }),
    );
    const output = lines.join("\n");
    expect(output).toContain("[warn] 微信服务可达性");
    expect(output).toContain("NODE_USE_ENV_PROXY=1");
  });
});
