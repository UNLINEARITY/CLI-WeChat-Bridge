#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

import {
  assertNoReservedExtraCliArgs,
  buildCliEnvironment,
  buildCodexCliArgs,
  resolveSpawnTarget,
} from "../bridge/bridge-adapters.shared.ts";
import {
  clearLocalCompanionOccupancy,
  readLocalCompanionEndpoint,
  updateLocalCompanionOccupancy,
  type LocalCompanionEndpoint,
} from "./local-companion-link.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import { CODEX_REMOTE_AUTH_TOKEN_ENV } from "../runtime/runtime-types.ts";

type CodexRemoteClientCliOptions = {
  cwd: string;
  cliArgs: string[];
};

function log(message: string): void {
  process.stderr.write(`[codex-remote-client] ${message}\n`);
}

export function parseCliArgs(argv: string[]): CodexRemoteClientCliOptions {
  let cwd = process.cwd();
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
          "Internal Codex client usage: npm run codex:panel -- [--cwd <path>] [...codex args]",
          "",
          "Connects the visible native Codex client to the bridge runtime for the current directory.",
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

    cliArgs.push(arg);
  }

  return { cwd, cliArgs };
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
  options: { extraCliArgs?: string[] } = {},
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
    resumeThreadId: endpoint.sharedThreadId,
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

export async function runCodexRemoteClientFromEndpoint(
  endpoint: LocalCompanionEndpoint,
  options: { extraCliArgs?: string[] } = {},
): Promise<number> {
  const spawnTarget = resolveSpawnTarget(endpoint.command, "codex");
  const args = buildRemoteCodexClientArgs(endpoint, {
    extraCliArgs: options.extraCliArgs,
  });
  const env = buildRemoteCodexClientEnv(endpoint);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      spawnTarget.file,
      [...spawnTarget.args, ...args],
      {
        cwd: endpoint.cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      },
    );

    if (typeof child.pid === "number") {
      updateLocalCompanionOccupancy(endpoint.cwd, {
        companionPid: child.pid,
        companionConnectedAt: new Date().toISOString(),
      }, endpoint.instanceId, { adapter: "codex" });
    }

    child.once("error", (error) => {
      clearLocalCompanionOccupancy(endpoint.cwd, endpoint.instanceId, {
        adapter: "codex",
      });
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearLocalCompanionOccupancy(endpoint.cwd, endpoint.instanceId, {
        adapter: "codex",
      });
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function runCodexRemoteClient(
  options: CodexRemoteClientCliOptions,
): Promise<number> {
  const endpoint = readCodexRuntimeEndpoint(options.cwd);
  return await runCodexRemoteClientFromEndpoint(endpoint, {
    extraCliArgs: options.cliArgs,
  });
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);
  const options = parseCliArgs(process.argv.slice(2));
  const exitCode = await runCodexRemoteClient(options);
  process.exit(exitCode);
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
