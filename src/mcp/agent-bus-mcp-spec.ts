// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeAdapterKind } from "../bridge/bridge-types.ts";

/**
 * How the CLIs the bridge launches start the agent bus MCP server
 * (agent-bus-mcp.ts). Kept apart from the server so adapters do not load
 * the MCP SDK.
 */
export const AGENT_BUS_MCP_SERVER_NAME = "cli-bridge";

const MODULE_FILE = fileURLToPath(import.meta.url);
const SERVER_ENTRY = path.join(path.dirname(MODULE_FILE), `agent-bus-mcp${path.extname(MODULE_FILE)}`);
/** Above the server's longest wait, so a waiting call is not cut off. */
const CODEX_TOOL_TIMEOUT_SEC = 150;

export type AgentBusIdentity = {
  cwd: string;
  adapter: BridgeAdapterKind;
  instance?: number;
};

/** `CLI_BRIDGE_AGENT_BUS=0` launches the CLIs without the agent tools. */
export function isAgentBusEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLI_BRIDGE_AGENT_BUS !== "0";
}

/** The server command for one slot; `--agent-*` names the calling slot. */
export function buildAgentBusMcpServerSpec(identity: AgentBusIdentity): { command: string; args: string[] } {
  const args = ["--no-warnings"];
  if (path.extname(SERVER_ENTRY) === ".ts") args.push("--experimental-strip-types");
  args.push(SERVER_ENTRY, "--agent-cwd", identity.cwd, "--agent-adapter", identity.adapter);
  if (identity.instance && identity.instance > 1) args.push("--agent-instance", String(identity.instance));
  return { command: process.execPath, args };
}

/**
 * `-c` overrides that add the server to a Codex app-server without touching
 * the user's config.toml. Values are TOML; JSON strings and string arrays
 * are valid TOML. Unless approvals are strict, the bridge's own tools run
 * without a Codex approval prompt: every call is mirrored to the operator,
 * and approvals inside the called CLI still apply.
 */
export function buildCodexAgentBusConfigArgs(identity: AgentBusIdentity, env: NodeJS.ProcessEnv = process.env): string[] {
  const spec = buildAgentBusMcpServerSpec(identity);
  const key = `mcp_servers.${AGENT_BUS_MCP_SERVER_NAME}`;
  return [
    "-c", `${key}.command=${JSON.stringify(spec.command)}`,
    "-c", `${key}.args=${JSON.stringify(spec.args)}`,
    "-c", `${key}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
    ...(env.CLI_BRIDGE_STRICT_APPROVAL === "1" ? [] : ["-c", `${key}.default_tools_approval_mode="approve"`]),
  ];
}

/** A `--mcp-config` value for Claude Code. */
export function buildClaudeAgentBusMcpConfig(identity: AgentBusIdentity): string {
  return JSON.stringify({ mcpServers: { [AGENT_BUS_MCP_SERVER_NAME]: buildAgentBusMcpServerSpec(identity) } });
}
