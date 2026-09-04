#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

import {
  assertNoReservedExtraCliArgs,
  buildCliEnvironment,
  buildCodexCliArgs,
  resolveSpawnTarget,
} from "../bridge/bridge-adapters.shared.ts";
import { killProcessTreeSync } from "../bridge/bridge-process-reaper.ts";
import {
  CODEX_VISIBLE_CONTROL_HOST,
  parseCodexVisibleControlRequest,
  sendCodexVisibleShutdownResponse,
  sendCodexVisibleSwitchResponse,
} from "./codex-visible-client-link.ts";
import {
  clearLocalCompanionOccupancy,
  readLocalCompanionEndpoint,
  updateCodexVisibleControl,
  updateLocalCompanionOccupancy,
  type LocalCompanionEndpoint,
} from "./local-companion-link.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import { CODEX_REMOTE_AUTH_TOKEN_ENV } from "../runtime/runtime-types.ts";
import { isDirectModuleRun } from "../core/direct-run.ts";

type CodexRemoteClientCliOptions = {
  cwd: string;
  cliArgs: string[];
  sessionStartMode?: "restore" | "new";
};

type CodexRemoteClientRunOptions = {
  extraCliArgs?: string[];
  sessionStartMode?: "restore" | "new";
};

type CodexChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

type CodexVisibleClientSupervisorDependencies = {
  spawnProcess?: typeof spawn;
  stopProcessTree?: (pid: number) => void;
  switchSettleMs?: number;
};

const CODEX_VISIBLE_SWITCH_SETTLE_MS = 500;
const CODEX_VISIBLE_CHILD_STOP_TIMEOUT_MS = 2_000;

function log(message: string): void {
  process.stderr.write(`[codex-remote-client] ${message}\n`);
}

export function parseCliArgs(argv: string[]): CodexRemoteClientCliOptions {
  let cwd = process.cwd();
  let sessionStartMode: CodexRemoteClientCliOptions["sessionStartMode"];
  const cliArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Internal Codex client usage: npm run codex:panel -- [--cwd <path>] [--session-start-mode <restore|new>] [...codex args]",
          "",
          "Connects the visible native Codex client to the bridge runtime for the current directory.",
          "Use --session-start-mode new to open the client without resuming the shared thread.",
          "Unknown arguments are forwarded to the Codex client.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--session-start-mode") {
      if (next !== "restore" && next !== "new") {
        throw new Error(`Invalid --session-start-mode value: ${next ?? "(missing)"}`);
      }
      sessionStartMode = next;
      i += 1;
      continue;
    }

    cliArgs.push(arg);
  }

  return { cwd, cliArgs, sessionStartMode };
}

export function readCodexRuntimeEndpoint(cwd: string): LocalCompanionEndpoint {
  const endpoint = readLocalCompanionEndpoint(cwd, { adapter: "codex" });
  if (!endpoint || endpoint.kind !== "codex") {
    throw new Error(
      `No active Codex runtime was found for ${cwd}. Run "wechat-codex" in that directory to recreate it.`,
    );
  }

  if (endpoint.runtimeKind !== "codex_runtime_host" || (!endpoint.serverUrl && !endpoint.serverPort)) {
    throw new Error(
      `The running Codex runtime for ${cwd} uses an older local client protocol. Run "wechat-codex" in that directory to replace it.`,
    );
  }

  return endpoint;
}

export function buildRemoteCodexClientArgs(
  endpoint: LocalCompanionEndpoint,
  options: CodexRemoteClientRunOptions & { resumeThreadId?: string } = {},
): string[] {
  const extraCliArgs = options.extraCliArgs ?? [];
  assertNoReservedExtraCliArgs(
    extraCliArgs,
    ["--remote", "--remote-auth-token-env"],
    "Codex remote connection",
  );
  const remoteUrl = endpoint.serverUrl ?? `ws://127.0.0.1:${endpoint.serverPort ?? endpoint.port}`;
  const args = buildCodexCliArgs(remoteUrl, {
    profile: endpoint.profile,
    // "new" skips resume so the visible client opens a fresh Codex session
    // instead of rejoining the shared thread.
    resumeThreadId:
      options.sessionStartMode === "new"
        ? undefined
        : options.resumeThreadId ?? endpoint.sharedThreadId,
  });
  const tokenEnvName = endpoint.remoteAuthTokenEnv ?? CODEX_REMOTE_AUTH_TOKEN_ENV;
  return [...args, "--remote-auth-token-env", tokenEnvName, ...extraCliArgs];
}

export function buildRemoteCodexClientEnv(
  endpoint: LocalCompanionEndpoint,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const tokenEnvName = endpoint.remoteAuthTokenEnv ?? CODEX_REMOTE_AUTH_TOKEN_ENV;
  const nextEnv = buildCliEnvironment("codex", { env });
  nextEnv[tokenEnvName] = endpoint.token;
  return nextEnv;
}

export class CodexVisibleClientSupervisor {
  private readonly endpoint: LocalCompanionEndpoint;
  private readonly options: CodexRemoteClientRunOptions;
  private readonly spawnProcess: typeof spawn;
  private readonly stopProcessTree: (pid: number) => void;
  private readonly switchSettleMs: number;
  private readonly controlToken = crypto.randomBytes(24).toString("hex");
  private readonly childExitPromises = new WeakMap<ChildProcess, Promise<CodexChildExit>>();
  private child: ChildProcess | null = null;
  private currentThreadId: string | undefined;
  private controlServer: net.Server | null = null;
  private controlPort: number | null = null;
  private switching = false;
  private switchChain: Promise<void> = Promise.resolve();
  private runSettled = false;
  private resolveRun: ((exitCode: number) => void) | null = null;
  private rejectRun: ((error: Error) => void) | null = null;

  constructor(
    endpoint: LocalCompanionEndpoint,
    options: CodexRemoteClientRunOptions = {},
    dependencies: CodexVisibleClientSupervisorDependencies = {},
  ) {
    this.endpoint = endpoint;
    this.options = options;
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.stopProcessTree = dependencies.stopProcessTree ?? killProcessTreeSync;
    this.switchSettleMs = dependencies.switchSettleMs ?? CODEX_VISIBLE_SWITCH_SETTLE_MS;
    this.currentThreadId =
      options.sessionStartMode === "new" ? undefined : endpoint.sharedThreadId;
  }

  async run(): Promise<number> {
    await this.startControlServer();
    this.publishControlMetadata();

    try {
      return await new Promise<number>((resolve, reject) => {
        this.resolveRun = resolve;
        this.rejectRun = reject;
        try {
          this.spawnChild(this.currentThreadId);
        } catch (error) {
          this.finishRun(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      await this.closeControlServer();
      updateCodexVisibleControl(
        this.endpoint.cwd,
        {
          codexControlPort: undefined,
          codexControlToken: undefined,
          codexVisibleThreadId: undefined,
        },
        this.endpoint.instanceId,
      );
      clearLocalCompanionOccupancy(this.endpoint.cwd, this.endpoint.instanceId, {
        adapter: "codex",
      });
    }
  }

  async switchThread(threadId: string): Promise<void> {
    const targetThreadId = threadId.trim();
    if (!targetThreadId) {
      throw new Error("A Codex thread id is required.");
    }

    const run = this.switchChain.then(() => this.performThreadSwitch(targetThreadId));
    this.switchChain = run.catch(() => undefined);
    await run;
  }

  private async performThreadSwitch(targetThreadId: string): Promise<void> {
    if (this.runSettled) {
      throw new Error("The visible Codex client has already stopped.");
    }
    const endpoint = readLocalCompanionEndpoint(this.endpoint.cwd, { adapter: "codex" });
    const previousThreadId = endpoint?.sharedThreadId ?? this.currentThreadId;
    const previousChild = this.child;
    this.switching = true;

    try {
      if (previousChild) {
        await this.stopChild(previousChild);
      }
      const nextChild = this.spawnChild(targetThreadId);
      await this.waitForStableChild(nextChild, targetThreadId);
      this.currentThreadId = targetThreadId;
      this.publishControlMetadata();
    } catch (error) {
      const switchError = error instanceof Error ? error : new Error(String(error));
      if (previousThreadId && previousThreadId !== targetThreadId) {
        try {
          const rollbackChild = this.spawnChild(previousThreadId);
          await this.waitForStableChild(rollbackChild, previousThreadId);
          this.currentThreadId = previousThreadId;
          this.publishControlMetadata();
        } catch (rollbackError) {
          throw new Error(
            `${switchError.message} Failed to restore the previous visible Codex thread: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
            { cause: rollbackError },
          );
        }
      }
      throw switchError;
    } finally {
      this.switching = false;
    }
  }

  private spawnChild(resumeThreadId?: string): ChildProcess {
    const spawnTarget = resolveSpawnTarget(this.endpoint.command, "codex");
    const args = buildRemoteCodexClientArgs(this.endpoint, {
      extraCliArgs: this.options.extraCliArgs,
      sessionStartMode: resumeThreadId ? "restore" : this.options.sessionStartMode,
      resumeThreadId,
    });
    const child = this.spawnProcess(
      spawnTarget.file,
      [...spawnTarget.args, ...args],
      {
        cwd: this.endpoint.cwd,
        env: buildRemoteCodexClientEnv(this.endpoint),
        stdio: "inherit",
        windowsHide: false,
      },
    );
    this.child = child;

    const exitPromise = new Promise<CodexChildExit>((resolve) => {
      let settled = false;
      const finish = (result: CodexChildExit) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      child.once("error", (error) => finish({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => finish({ code, signal }));
    });
    this.childExitPromises.set(child, exitPromise);
    void exitPromise.then((result) => {
      if (this.child !== child || this.switching) {
        return;
      }
      this.child = null;
      if (result.error) {
        this.finishRun(result.error);
        return;
      }
      this.finishRun(undefined, result.code ?? (result.signal ? 1 : 0));
    });
    return child;
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (this.child === child) {
      this.child = null;
    }
    try {
      if (typeof child.pid === "number") {
        this.stopProcessTree(child.pid);
      } else {
        child.kill();
      }
    } catch {
      // The child may have already exited between the switch request and cleanup.
    }
    const exitPromise = this.childExitPromises.get(child);
    if (!exitPromise) {
      return;
    }
    await Promise.race([
      exitPromise.then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CODEX_VISIBLE_CHILD_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  }

  private async waitForStableChild(child: ChildProcess, threadId: string): Promise<void> {
    const exitPromise = this.childExitPromises.get(child);
    const result = await Promise.race([
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), this.switchSettleMs);
        timer.unref?.();
      }),
      exitPromise?.then((exit) => exit) ?? Promise.resolve<CodexChildExit>({
        code: null,
        signal: null,
        error: new Error("The visible Codex process did not expose an exit state."),
      }),
    ]);
    if (result === null) {
      return;
    }
    if (this.child === child) {
      this.child = null;
    }
    const detail = result.error
      ? result.error.message
      : result.signal
        ? `signal ${result.signal}`
        : `code ${result.code ?? "unknown"}`;
    throw new Error(`The visible Codex client exited while opening ${threadId} (${detail}).`);
  }

  private async startControlServer(): Promise<void> {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.setTimeout(20_000);
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 65_536) {
          socket.destroy();
          return;
        }
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        const request = parseCodexVisibleControlRequest(parsed);
        if (!request || request.token !== this.controlToken) {
          socket.destroy();
          return;
        }
        if (request.type === "shutdown") {
          sendCodexVisibleShutdownResponse(socket, {
            type: "shutdown_result",
            id: request.id,
            ok: true,
          });
          void this.shutdownFromControl();
          return;
        }
        void this.switchThread(request.threadId).then(
          () => {
            sendCodexVisibleSwitchResponse(socket, {
              type: "switch_thread_result",
              id: request.id,
              ok: true,
              threadId: request.threadId,
            });
          },
          (error) => {
            sendCodexVisibleSwitchResponse(socket, {
              type: "switch_thread_result",
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
      });
      socket.once("timeout", () => socket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, CODEX_VISIBLE_CONTROL_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not create the visible Codex control endpoint.");
    }
    this.controlServer = server;
    this.controlPort = address.port;
  }

  private async shutdownFromControl(): Promise<void> {
    await this.switchChain.catch(() => undefined);
    if (this.runSettled) {
      return;
    }

    const child = this.child;
    if (child) {
      await this.stopChild(child);
    }
    this.finishRun(undefined, 0);
  }

  private async closeControlServer(): Promise<void> {
    const server = this.controlServer;
    this.controlServer = null;
    this.controlPort = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private publishControlMetadata(): void {
    updateLocalCompanionOccupancy(
      this.endpoint.cwd,
      {
        companionPid: process.pid,
        companionConnectedAt: new Date().toISOString(),
      },
      this.endpoint.instanceId,
      { adapter: "codex" },
    );
    updateCodexVisibleControl(
      this.endpoint.cwd,
      {
        codexControlPort: this.controlPort ?? undefined,
        codexControlToken: this.controlToken,
        codexVisibleThreadId: this.currentThreadId,
      },
      this.endpoint.instanceId,
    );
  }

  private finishRun(error?: Error, exitCode = 0): void {
    if (this.runSettled) {
      return;
    }
    this.runSettled = true;
    if (error) {
      this.rejectRun?.(error);
    } else {
      this.resolveRun?.(exitCode);
    }
  }
}

export async function runCodexRemoteClientFromEndpoint(
  endpoint: LocalCompanionEndpoint,
  options: CodexRemoteClientRunOptions = {},
): Promise<number> {
  return await new CodexVisibleClientSupervisor(endpoint, options).run();
}

export async function runCodexRemoteClient(
  options: CodexRemoteClientCliOptions,
): Promise<number> {
  const endpoint = readCodexRuntimeEndpoint(options.cwd);
  return await runCodexRemoteClientFromEndpoint(endpoint, {
    extraCliArgs: options.cliArgs,
    sessionStartMode: options.sessionStartMode,
  });
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);
  const options = parseCliArgs(process.argv.slice(2));
  const exitCode = await runCodexRemoteClient(options);
  process.exit(exitCode);
}

const isDirectRun = isDirectModuleRun(
  import.meta.url,
  process.argv,
  (import.meta as ImportMeta & { main?: boolean }).main,
);
if (isDirectRun) {
  main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
