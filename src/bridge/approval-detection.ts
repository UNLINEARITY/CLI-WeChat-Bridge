// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { ApprovalRequest } from "./bridge-types.ts";
import { normalizeOutput, truncatePreview } from "../core/text-utils.ts";

const HIGH_RISK_PATTERNS = [
  /\bremove-item\b/i,
  /\brd\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bformat\b(?!-)/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bstop-process\b/i,
  /\btaskkill\b/i,
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bset-executionpolicy\b/i,
  /\bstart-process\b.*\b-verb\s+runas\b/i,
  /\b(?:invoke-expression|iex)\b/i,
  /\bcurl\b.*\|\s*(?:iex|powershell)\b/i,
  /\binvoke-webrequest\b.*\|\s*(?:iex|powershell)\b/i,
  /\brm\b\s+/i,
  /\brm\b\s+-[A-Za-z-]*r[A-Za-z-]*/i,
  /\bfind\b[^\r\n]*\s-delete\b/i,
  /\bfind\b[^\r\n]*\s-exec\s+(?:rm|rmdir|del|erase|remove-item)\b/i,
  /\bxargs\b[^\r\n]*\b(?:rm|rmdir|del|erase|remove-item)\b/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\b/i,
  /\breboot\b/i,
  /\bsystemctl\b/i,
  /\blaunchctl\b/i,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash|zsh)\b/i,
];

export function isHighRiskShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectCliApproval(text: string): ApprovalRequest | null {
  const normalized = normalizeOutput(text);
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const approvalPatterns: Array<{
    pattern: RegExp;
    confirmInput?: string;
    denyInput?: string;
  }> = [
    { pattern: /\bdo you want to allow\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\bapprove\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\ballow this\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\b\(y\/n\)\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\byes\/no\b/i, confirmInput: "yes\r", denyInput: "no\r" },
    { pattern: /\bpress enter to continue\b/i, confirmInput: "\r" },
    { pattern: /\bconfirm to continue\b/i, confirmInput: "y\r", denyInput: "n\r" },
  ];

  const matched = approvalPatterns.find(({ pattern }) => pattern.test(compact));
  if (!matched) {
    return null;
  }

  const preview = truncatePreview(compact, 160);
  return {
    source: "cli",
    summary: "CLI approval is required before the session can continue.",
    commandPreview: preview,
    confirmInput: matched.confirmInput,
    denyInput: matched.denyInput,
  };
}

// When CLI_BRIDGE_STRICT_APPROVAL is enabled, no permission request is
// auto-approved: everything is forwarded to WeChat for an explicit
// /confirm or /deny decision.
export function isStrictApprovalModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.CLI_BRIDGE_STRICT_APPROVAL?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
