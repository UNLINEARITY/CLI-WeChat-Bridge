// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import os from "node:os";
import path from "node:path";
import { isHighRiskShellCommand, isStrictApprovalModeEnabled } from "./approval-detection.ts";
import { truncatePreview } from "../core/text-utils.ts";
import type { AutoApprovalKind } from "./bridge-types.ts";

/**
 * One permission request, described independently of the CLI that raised it.
 * The bridge only sees requests the CLI itself decided to ask about, so a
 * CLI running with full access never reaches this policy.
 */
export type ApprovalOperation =
  | { kind: "command"; command: string; cwd?: string; writePaths?: string[] }
  | { kind: "file_write"; paths: string[] }
  | { kind: "permissions"; writePaths: string[]; touchesRoot?: boolean }
  | { kind: "external_directory"; paths: string[] }
  | { kind: "mcp"; tool: string }
  | { kind: "network"; target?: string }
  | { kind: "read"; target?: string }
  | { kind: "user_decision"; label: string }
  | { kind: "unknown"; label: string };

export type ApprovalOperationKind = ApprovalOperation["kind"];

export function toAutoApprovalKind(kind: ApprovalOperationKind): AutoApprovalKind {
  return kind === "command" || kind === "file_write" || kind === "permissions" || kind === "network" || kind === "read"
    ? kind
    : "other";
}

export type ApprovalVerdict =
  | { decision: "auto_allow"; reason: string }
  | { decision: "ask"; reason: string };

export type ApprovalPolicyContext = {
  /** The workspace the CLI was opened in. */
  workspace: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Runtime switch set by `/auto on|off`; `null` follows
 * CLI_BRIDGE_STRICT_APPROVAL. Each process (daemon, companion) holds its own
 * copy, synchronized by the daemon.
 */
let autoApprovalOverride: boolean | null = null;

export function setAutoApprovalOverride(enabled: boolean | null): void {
  autoApprovalOverride = enabled;
}

export function getAutoApprovalOverride(): boolean | null {
  return autoApprovalOverride;
}

export function isAutoApprovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return autoApprovalOverride ?? !isStrictApprovalModeEnabled(env);
}

/** Operations that publish, deploy, or otherwise act outside this machine. */
const OUTWARD_PATTERNS = [
  /\bgit\s+push\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate)\b/i,
  /\b(?:cargo|gem)\s+(?:publish|push|yank)\b/i,
  /\btwine\s+upload\b/i,
  /\bpod\s+trunk\s+push\b/i,
  /\b(?:docker|podman)\s+(?:push|login)\b/i,
  /\bdocker\s+buildx\b[^\r\n]*--push\b/i,
  /\bgh\s+release\s+(?:create|upload|delete|edit)\b/i,
  /\bgh\s+pr\s+(?:merge|close|create)\b/i,
  /\bgh\s+repo\s+(?:create|delete|archive|rename|edit)\b/i,
  /\bgh\s+(?:workflow\s+run|run\s+(?:rerun|cancel))\b/i,
  /\bgh\s+api\b[^\r\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
  /(?<![\w./-])deploy(?![\w./-])/i,
  /\bvercel\b[^\r\n]*--prod\b/i,
  /\bwrangler\s+publish\b/i,
  /\bkubectl\s+(?:apply|create|delete|replace|patch|rollout|scale|set)\b/i,
  /\bterraform\s+(?:apply|destroy|import)\b/i,
  /\bpulumi\s+(?:up|destroy)\b/i,
  /\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/i,
  /\baws\s+s3\s+(?:cp|mv|rm|sync|rb)\b/i,
  /(?<![\w./-])(?:scp|sftp|ssh)(?![\w./-])/i,
  /\brsync\b[^\r\n]*\s\S+:\S*/i,
];

/** Destructive local operations missing from the original Windows-era list. */
const EXTRA_HIGH_RISK_PATTERNS = [
  /\bchmod\s+-[A-Za-z]*R/,
  /\bchown\s+-[A-Za-z]*R/,
  /\bgit\s+checkout\s+(?:-f\b|--\s)/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+stash\s+(?:drop|clear)\b/i,
  /\bgit\s+(?:filter-branch|filter-repo)\b/i,
  /\bshred\b/i,
  /\btruncate\b/i,
  /\b(?:pkill|killall)\b/i,
  /\bkill\s+-(?:9|KILL)\b/i,
  /\bdiskutil\b/i,
  /\bcrontab\s+-r\b/i,
];

/** Commands that write to the files named in their arguments. */
const WRITE_COMMAND_PATTERN =
  /\b(?:tee|cp|mv|mkdir|touch|ln|install|rsync|truncate|chmod|chown|unzip|tar)\b|\bsed\b[^\r\n]*\s-i/i;
/** Targets of `>` and `>>` redirections; `2>&1` duplicates a descriptor. */
const REDIRECT_TARGET_PATTERN = /\d*>>?\s*(?!&)([^\s;&|<>()]+)/g;

const DEVICE_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

export function isOutwardShellCommand(command: string): boolean {
  return OUTWARD_PATTERNS.some((pattern) => pattern.test(command));
}

function isDangerousShellCommand(command: string): boolean {
  return isHighRiskShellCommand(command) || EXTRA_HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

export function isPathInsideWorkspace(target: string, workspace: string, base = workspace): boolean {
  const trimmed = target.trim();
  if (!trimmed) return true;
  // Git Bash also uses POSIX devices; Windows resolution would add a drive.
  if (DEVICE_PATHS.has(path.posix.normalize(trimmed))) return true;
  const resolved = path.resolve(base, expandHome(trimmed));
  if (DEVICE_PATHS.has(resolved)) return true;
  const relative = path.relative(path.resolve(workspace), resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Path-like arguments of a shell command: absolute, home-relative, or `..`. */
function extractCommandPaths(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s;&|<>()]+/g) ?? [];
  return tokens
    .map((token) => token.replace(/^["']|["']$/g, "").replace(/^-[A-Za-z-]+=/, ""))
    .filter((token) => /^(?:\/|~(?:\/|$)|\.\.(?:\/|$))/.test(token));
}

function commandWritesOutsideWorkspace(command: string, cwd: string, workspace: string): boolean {
  const redirects = Array.from(command.matchAll(REDIRECT_TARGET_PATTERN), (match) => match[1]!.replace(/^["']|["']$/g, ""));
  const writes = WRITE_COMMAND_PATTERN.test(command);
  if (!writes && !redirects.length) return false;
  if (!isPathInsideWorkspace(cwd, workspace)) return true;
  const targets = writes ? [...redirects, ...extractCommandPaths(command)] : redirects;
  return targets.some((target) => !isPathInsideWorkspace(target, workspace, cwd));
}

function outsideWorkspace(paths: string[], context: ApprovalPolicyContext): string | undefined {
  return paths.find((target) => !isPathInsideWorkspace(target, context.workspace));
}

/** The single auto-approval rule shared by every adapter. */
export function evaluateApprovalPolicy(
  operation: ApprovalOperation,
  context: ApprovalPolicyContext,
): ApprovalVerdict {
  if (!isAutoApprovalEnabled(context.env ?? process.env)) {
    return { decision: "ask", reason: "auto-approval is off" };
  }

  switch (operation.kind) {
    case "command": {
      const command = operation.command.trim();
      if (!command) return { decision: "ask", reason: "command not shown" };
      const preview = truncatePreview(command, 120);
      if (isDangerousShellCommand(command)) return { decision: "ask", reason: `high-risk command ${preview}` };
      if (isOutwardShellCommand(command)) return { decision: "ask", reason: `outward command ${preview}` };
      const cwd = operation.cwd ? path.resolve(context.workspace, operation.cwd) : context.workspace;
      if (commandWritesOutsideWorkspace(command, cwd, context.workspace)) {
        return { decision: "ask", reason: `command writes outside the workspace ${preview}` };
      }
      const outside = outsideWorkspace(operation.writePaths ?? [], context);
      if (outside) return { decision: "ask", reason: `write outside the workspace ${outside}` };
      return { decision: "auto_allow", reason: `command ${preview}` };
    }
    case "file_write": {
      if (!operation.paths.length) return { decision: "ask", reason: "file change without known paths" };
      const outside = outsideWorkspace(operation.paths, context);
      if (outside) return { decision: "ask", reason: `write outside the workspace ${outside}` };
      return { decision: "auto_allow", reason: `file change ${truncatePreview(operation.paths.join(", "), 120)}` };
    }
    case "permissions": {
      if (operation.touchesRoot) return { decision: "ask", reason: "permission grant on a system root" };
      const outside = outsideWorkspace(operation.writePaths, context);
      if (outside) return { decision: "ask", reason: `write access outside the workspace ${outside}` };
      return { decision: "auto_allow", reason: "permission grant inside the workspace" };
    }
    case "external_directory":
      return { decision: "ask", reason: `access outside the workspace ${operation.paths.join(", ")}` };
    case "mcp":
      return { decision: "ask", reason: `MCP tool ${operation.tool}` };
    case "network":
      return { decision: "auto_allow", reason: `network access${operation.target ? ` ${operation.target}` : ""}` };
    case "read":
      return { decision: "auto_allow", reason: `read${operation.target ? ` ${operation.target}` : ""}` };
    case "user_decision":
      return { decision: "ask", reason: operation.label };
    case "unknown":
      return { decision: "ask", reason: `unrecognized permission ${operation.label}` };
  }
}
