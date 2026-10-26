// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildClaudeCliArgs } from "../../src/bridge/bridge-adapters.shared.ts";
import type { DaemonRequest } from "../../src/daemon/daemon-link.ts";
import {
  AGENT_BUS_TOOLS,
  createAgentBusMcpServer,
  parseAgentIdentity,
  parseAgentTarget,
  runAgentBusTool,
} from "../../src/mcp/agent-bus-mcp.ts";
import {
  buildClaudeAgentBusMcpConfig,
  buildCodexAgentBusConfigArgs,
  isAgentBusEnabled,
} from "../../src/mcp/agent-bus-mcp-spec.ts";

const CWD = "/work/app";
const CALLER = { cwd: CWD, adapter: "claude" as const, instance: 1 };

function recorder(result: unknown = { callId: "call-1", status: "running" }) {
  const requests: { request: DaemonRequest; timeoutMs: number }[] = [];
  return {
    requests,
    request: async (request: DaemonRequest, timeoutMs: number) => {
      requests.push({ request, timeoutMs });
      return result;
    },
  };
}

describe("agent bus MCP targets and identity", () => {
  test("names the operator's window by adapter and others by display name", () => {
    expect(parseAgentTarget("codex", CWD)).toEqual({ cwd: CWD, adapter: "codex" });
    expect(parseAgentTarget("codex-w2", CWD)).toEqual({ cwd: CWD, adapter: "codex", name: "codex-w2" });
    expect(parseAgentTarget("pi-2", CWD)).toEqual({ cwd: CWD, adapter: "pi", name: "pi-2" });
    expect(() => parseAgentTarget("gemini", CWD)).toThrow("Unknown agent gemini");
  });

  test("reads the calling slot from the launch arguments", () => {
    expect(parseAgentIdentity(["--agent-cwd", CWD, "--agent-adapter", "codex", "--agent-instance", "101"]))
      .toEqual({ cwd: CWD, adapter: "codex", instance: 101 });
    expect(parseAgentIdentity(["--agent-cwd", CWD, "--agent-adapter", "claude"])).toEqual(CALLER);
    expect(parseAgentIdentity(["--agent-adapter", "claude"])).toBeUndefined();
    expect(parseAgentIdentity(["--agent-cwd", CWD, "--agent-adapter", "vim"])).toBeUndefined();
  });
});

describe("agent bus MCP tools", () => {
  test("sends a task without waiting by default", async () => {
    const daemon = recorder();
    await runAgentBusTool({ name: "send_to_agent", args: { target: "codex-w1", text: "fix it" }, caller: CALLER, request: daemon.request });

    expect(daemon.requests.map((entry) => entry.request)).toEqual([{
      command: "agent_call",
      caller: CALLER,
      target: { cwd: CWD, adapter: "codex", name: "codex-w1" },
      text: "fix it",
    }]);
  });

  test("waits for a sent task within the bounded window and takes its result", async () => {
    const daemon = recorder();
    await runAgentBusTool({ name: "send_to_agent", args: { target: "codex", text: "go", wait_seconds: 600 }, caller: CALLER, request: daemon.request });

    const wait = daemon.requests[1]!;
    expect(wait.request).toEqual({ command: "agent_wait", callId: "call-1", waitMs: 45_000, consume: true });
    expect(wait.timeoutMs).toBeGreaterThan(45_000);
  });

  test("reads a call's status as taken, so it is not delivered again", async () => {
    const daemon = recorder();
    await runAgentBusTool({ name: "get_agent_call", args: { call_id: "call-9" }, caller: CALLER, request: daemon.request });
    expect(daemon.requests[0]!.request).toEqual({ command: "agent_get", callId: "call-9", consume: true });
  });

  test("opens a worker in the caller's workspace", async () => {
    const daemon = recorder();
    await runAgentBusTool({ name: "open_agent", args: { adapter: "codex", visible: true }, caller: CALLER, request: daemon.request });
    expect(daemon.requests[0]!.request).toEqual({ command: "agent_open", caller: CALLER, adapter: "codex", cwd: CWD, visible: true });
    await expect(runAgentBusTool({ name: "open_agent", args: { adapter: "vim" }, caller: CALLER, request: daemon.request }))
      .rejects.toThrow("adapter must be one of");
  });

  test("decides approvals only for a known calling agent", async () => {
    const daemon = recorder();
    await expect(runAgentBusTool({ name: "resolve_agent_approval", args: { call_id: "call-1", decision: "confirm" }, request: daemon.request }))
      .rejects.toThrow("Only an agent run by the bridge");
    await expect(runAgentBusTool({ name: "resolve_agent_approval", args: { call_id: "call-1", decision: "always" }, caller: CALLER, request: daemon.request }))
      .rejects.toThrow("decision must be");

    await runAgentBusTool({
      name: "resolve_agent_approval",
      args: { call_id: "call-1", decision: "deny", reason: "not in prod" },
      caller: CALLER,
      request: daemon.request,
    });
    expect(daemon.requests.at(-1)!.request).toEqual({
      command: "agent_approve",
      callId: "call-1",
      caller: CALLER,
      decision: "deny",
      reason: "not in prod",
    });
  });

  test("serves the tools over MCP and reports daemon errors as tool errors", async () => {
    let fail = false;
    const server = createAgentBusMcpServer({
      caller: CALLER,
      request: async (request) => {
        if (fail) throw new Error("Agent codex is not open in /work/app.");
        return request.command === "agent_list" ? [{ name: "codex", idle: true }] : null;
      },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(AGENT_BUS_TOOLS.map((tool) => tool.name));

    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toEqual([{ name: "codex", idle: true }]);

    fail = true;
    const failed = await client.callTool({ name: "send_to_agent", arguments: { target: "codex", text: "hi" } });
    expect(failed.isError).toBe(true);
    expect((failed.content as { text: string }[])[0]!.text).toBe("error: Agent codex is not open in /work/app.");
    await client.close();
  });
});

describe("agent bus MCP launch arguments", () => {
  test("adds the server to a Codex app-server through config overrides", () => {
    const args = buildCodexAgentBusConfigArgs({ cwd: CWD, adapter: "codex", instance: 101 });
    const values = args.filter((_, index) => index % 2 === 1);
    expect(args.filter((_, index) => index % 2 === 0)).toEqual(["-c", "-c", "-c", "-c"]);
    expect(values[0]).toBe(`mcp_servers.cli-bridge.command=${JSON.stringify(process.execPath)}`);
    const serverArgs = JSON.parse(values[1]!.slice("mcp_servers.cli-bridge.args=".length)) as string[];
    expect(serverArgs.slice(-6)).toEqual(["--agent-cwd", CWD, "--agent-adapter", "codex", "--agent-instance", "101"]);
    expect(serverArgs.find((arg) => arg.includes("agent-bus-mcp"))).toMatch(/agent-bus-mcp\.(ts|js)$/);
    expect(values[2]).toBe("mcp_servers.cli-bridge.tool_timeout_sec=150");
    expect(values[3]).toBe('mcp_servers.cli-bridge.default_tools_approval_mode="approve"');
  });

  test("passes the server to Claude ahead of the settings option", () => {
    const mcpConfig = buildClaudeAgentBusMcpConfig({ cwd: CWD, adapter: "claude" });
    const args = buildClaudeCliArgs({ settingsFilePath: "/tmp/settings.json", mcpConfig });

    expect(args.slice(0, 4)).toEqual(["--mcp-config", mcpConfig, "--settings", "/tmp/settings.json"]);
    const parsed = JSON.parse(mcpConfig) as { mcpServers: Record<string, { args: string[] }> };
    expect(parsed.mcpServers["cli-bridge"]!.args.slice(-4)).toEqual(["--agent-cwd", CWD, "--agent-adapter", "claude"]);
  });

  test("keeps Codex's approval prompt for the tools under strict approvals", () => {
    const args = buildCodexAgentBusConfigArgs({ cwd: CWD, adapter: "codex" }, { CLI_BRIDGE_STRICT_APPROVAL: "1" });
    expect(args.some((arg) => arg.includes("default_tools_approval_mode"))).toBe(false);
  });

  test("can be switched off for every launch", () => {
    expect(isAgentBusEnabled({})).toBe(true);
    expect(isAgentBusEnabled({ CLI_BRIDGE_AGENT_BUS: "0" })).toBe(false);
  });
});
