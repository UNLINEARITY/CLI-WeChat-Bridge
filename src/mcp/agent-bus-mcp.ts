// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { isDirectModuleRun } from "../core/direct-run.ts";
import type { AgentRef } from "../daemon/agent-bus.ts";
import {
  type DaemonAdapterKind,
  type DaemonRequest,
  readDaemonEndpoint,
  sendDaemonRequest,
} from "../daemon/daemon-link.ts";
import { AGENT_BUS_MCP_SERVER_NAME } from "./agent-bus-mcp-spec.ts";

/*
 * MCP server that lets a CLI running under the bridge call the daemon's
 * other CLIs (see src/daemon/agent-bus.ts). The bridge starts it inside each
 * CLI it launches (agent-bus-mcp-spec.ts) and names the calling slot with
 * `--agent-*` arguments.
 */

const ADAPTERS: readonly DaemonAdapterKind[] = ["codex", "claude", "opencode", "pi"];
const AGENT_NAME_PATTERN = /^(codex|claude|opencode|pi)(?:-(?:w)?\d+)?$/;
const MAX_WAIT_SECONDS = 45;
const REQUEST_MARGIN_MS = 10_000;
const OPEN_TIMEOUT_MS = 120_000;

/** The calling slot named by `--agent-*` arguments; absent when started by hand. */
export function parseAgentIdentity(argv: string[]): AgentRef | undefined {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const cwd = value("--agent-cwd");
  const adapter = value("--agent-adapter");
  if (!cwd || !adapter || !ADAPTERS.includes(adapter as DaemonAdapterKind)) return undefined;
  const instance = Number(value("--agent-instance") ?? 1);
  return { cwd, adapter: adapter as DaemonAdapterKind, instance: Number.isInteger(instance) && instance > 0 ? instance : 1 };
}

export type AgentBusRequest = (request: DaemonRequest, timeoutMs: number) => Promise<unknown>;

/** Sends one request to the running daemon; rejects with the daemon's error. */
export const requestRunningDaemon: AgentBusRequest = async (request, timeoutMs) => {
  const endpoint = readDaemonEndpoint();
  if (!endpoint) throw new Error("No bridge daemon is running; start one with a launcher such as wechat-codex.");
  const response = await sendDaemonRequest(endpoint, request, { timeoutMs });
  if (!response.ok) throw new Error(response.error);
  return response.result;
};

const targetProperty = {
  type: "string",
  description: "Agent name from list_agents, e.g. codex, claude, codex-2, or codex-w1.",
} as const;
const callIdProperty = { type: "string", description: "Call id returned by send_to_agent." } as const;
const waitProperty = {
  type: "number",
  description: `Seconds to wait for the call to finish or need a decision (0-${MAX_WAIT_SECONDS}). 0 returns at once.`,
} as const;

export const AGENT_BUS_TOOLS = [
  {
    name: "list_agents",
    description: "List the CLI agents of the bridge: name, workspace, status, queued calls, and workers opened by agents.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "open_agent",
    description:
      "Open a new worker agent with a fresh session (codex, claude, opencode, or pi) in this workspace. " +
      "A Codex worker runs without a window unless visible is true; the other CLIs open a terminal window. " +
      "Close it with close_agent when done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        adapter: { type: "string", enum: [...ADAPTERS] },
        visible: { type: "boolean", description: "Codex only: open a terminal window for the worker." },
        cwd: { type: "string", description: "Workspace directory; defaults to yours." },
      },
      required: ["adapter"],
    },
  },
  {
    name: "send_to_agent",
    description:
      "Give another agent a task. It runs like a background job: the call returns a call id at once (queued while the " +
      "target is busy), and the result arrives later as a new message to you, starting with [<agent> finished task <id>]. " +
      "Use wait_seconds or get_agent_call only when you need the result before going on.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: targetProperty,
        text: { type: "string", description: "The task, written for the other agent." },
        wait_seconds: waitProperty,
        cwd: { type: "string", description: "Workspace of the target; defaults to yours." },
      },
      required: ["target", "text"],
    },
  },
  {
    name: "get_agent_call",
    description:
      "Status of a call: queued, running, awaiting_approval, awaiting_input, completed, failed, or interrupted, with the reply " +
      "once finished. A result read here is not sent to you again as a message.",
    inputSchema: {
      type: "object" as const,
      properties: { call_id: callIdProperty, wait_seconds: waitProperty },
      required: ["call_id"],
    },
  },
  {
    name: "resolve_agent_approval",
    description:
      "Decide an approval the target agent is waiting on for a call you made: confirm, deny, or abort (deny and stop its turn). " +
      "The operator can decide it too; whoever answers first wins.",
    inputSchema: {
      type: "object" as const,
      properties: {
        call_id: callIdProperty,
        decision: { type: "string", enum: ["confirm", "deny", "abort"] },
        reason: { type: "string", description: "Why you deny; passed to the agent where its CLI supports it." },
        request_id: { type: "string", description: "Approval request id from get_agent_call, to decide a specific one." },
      },
      required: ["call_id", "decision"],
    },
  },
  {
    name: "interrupt_agent_call",
    description: "Stop a call: drop it from the queue, or interrupt the target's turn that runs it.",
    inputSchema: { type: "object" as const, properties: { call_id: callIdProperty }, required: ["call_id"] },
  },
  {
    name: "close_agent",
    description: "Close a worker you opened with open_agent.",
    inputSchema: { type: "object" as const, properties: { target: targetProperty }, required: ["target"] },
  },
  {
    name: "new_agent_session",
    description: "Start a fresh session in an idle worker you opened, dropping its earlier context.",
    inputSchema: { type: "object" as const, properties: { target: targetProperty }, required: ["target"] },
  },
];

export const AGENT_BUS_INSTRUCTIONS = [
  "These tools reach the other CLI agents (Codex, Claude Code, OpenCode, Pi) run by the same bridge.",
  "send_to_agent works like starting a background job: you get a call id at once, and the result comes back to you",
  "later as a new message, so you can end your turn instead of polling. Open extra workers with open_agent when the",
  "existing agents are busy or the task needs a clean session, and close them when done. Every exchange is mirrored",
  "to the operator, who can step in at any time.",
].join(" ");

type ToolArgs = Record<string, unknown>;

function stringArg(args: ToolArgs, name: string, required: true): string;
function stringArg(args: ToolArgs, name: string, required?: false): string | undefined;
function stringArg(args: ToolArgs, name: string, required = false): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`${name} is required.`);
  return undefined;
}

function waitMs(args: ToolArgs): number {
  const seconds = typeof args.wait_seconds === "number" && Number.isFinite(args.wait_seconds) ? args.wait_seconds : 0;
  return Math.round(Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1_000);
}

/** `codex` names the operator's window; `codex-2` and `codex-w1` name a numbered one. */
export function parseAgentTarget(name: string, cwd: string): AgentRef {
  const trimmed = name.trim();
  const match = AGENT_NAME_PATTERN.exec(trimmed);
  if (!match) throw new Error(`Unknown agent ${name}; use a name from list_agents.`);
  const adapter = match[1] as DaemonAdapterKind;
  return trimmed === adapter ? { cwd, adapter } : { cwd, adapter, name: trimmed };
}

/** Runs one tool against the daemon for the calling agent. */
export async function runAgentBusTool(params: {
  name: string;
  args: ToolArgs;
  caller?: AgentRef;
  request: AgentBusRequest;
  /** Workspace used when the caller is unknown. */
  defaultCwd?: string;
}): Promise<unknown> {
  const { args, caller, request } = params;
  const cwd = stringArg(args, "cwd") ?? caller?.cwd ?? params.defaultCwd ?? process.cwd();
  const callerField = caller ? { caller } : {};
  switch (params.name) {
    case "list_agents":
      return request({ command: "agent_list" }, REQUEST_MARGIN_MS);
    case "open_agent": {
      const adapter = stringArg(args, "adapter", true) as DaemonAdapterKind;
      if (!ADAPTERS.includes(adapter)) throw new Error(`adapter must be one of ${ADAPTERS.join(", ")}.`);
      return request({
        command: "agent_open",
        ...callerField,
        adapter,
        cwd,
        ...(typeof args.visible === "boolean" ? { visible: args.visible } : {}),
      }, OPEN_TIMEOUT_MS);
    }
    case "send_to_agent": {
      const view = await request({
        command: "agent_call",
        ...callerField,
        target: parseAgentTarget(stringArg(args, "target", true), cwd),
        text: stringArg(args, "text", true),
      }, REQUEST_MARGIN_MS) as { callId: string };
      const wait = waitMs(args);
      return wait > 0
        ? request({ command: "agent_wait", callId: view.callId, waitMs: wait, consume: true }, wait + REQUEST_MARGIN_MS)
        : view;
    }
    case "get_agent_call": {
      const callId = stringArg(args, "call_id", true);
      const wait = waitMs(args);
      return wait > 0
        ? request({ command: "agent_wait", callId, waitMs: wait, consume: true }, wait + REQUEST_MARGIN_MS)
        : request({ command: "agent_get", callId, consume: true }, REQUEST_MARGIN_MS);
    }
    case "resolve_agent_approval": {
      if (!caller) throw new Error("Only an agent run by the bridge can decide approvals.");
      const decision = stringArg(args, "decision", true);
      if (decision !== "confirm" && decision !== "deny" && decision !== "abort") {
        throw new Error("decision must be confirm, deny, or abort.");
      }
      const reason = stringArg(args, "reason");
      const requestId = stringArg(args, "request_id");
      return request({
        command: "agent_approve",
        callId: stringArg(args, "call_id", true),
        caller,
        decision,
        ...(reason ? { reason } : {}),
        ...(requestId ? { requestId } : {}),
      }, REQUEST_MARGIN_MS);
    }
    case "interrupt_agent_call":
      return request({ command: "agent_interrupt", callId: stringArg(args, "call_id", true) }, REQUEST_MARGIN_MS);
    case "close_agent":
      return request({ command: "agent_close", ...callerField, target: parseAgentTarget(stringArg(args, "target", true), cwd) }, REQUEST_MARGIN_MS);
    case "new_agent_session":
      return request({ command: "agent_new_session", ...callerField, target: parseAgentTarget(stringArg(args, "target", true), cwd) }, OPEN_TIMEOUT_MS);
    default:
      throw new Error(`Unknown tool: ${params.name}`);
  }
}

export function createAgentBusMcpServer(params: { caller?: AgentRef; request?: AgentBusRequest }): Server {
  const request = params.request ?? requestRunningDaemon;
  const server = new Server(
    { name: AGENT_BUS_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: AGENT_BUS_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AGENT_BUS_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await runAgentBusTool({
        name: req.params.name,
        args: (req.params.arguments ?? {}) as ToolArgs,
        caller: params.caller,
        request,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
  return server;
}

async function main(): Promise<void> {
  const server = createAgentBusMcpServer({ caller: parseAgentIdentity(process.argv.slice(2)) });
  await server.connect(new StdioServerTransport());
}

const isDirectRun = isDirectModuleRun(
  import.meta.url,
  process.argv,
  (import.meta as ImportMeta & { main?: boolean }).main,
);
if (isDirectRun) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
