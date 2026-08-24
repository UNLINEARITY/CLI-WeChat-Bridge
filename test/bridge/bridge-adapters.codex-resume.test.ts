import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildCodexResumeCandidatesFromThreadList,
  CodexPtyAdapter,
} from "../../src/bridge/bridge-adapters.codex.ts";

function buildThread(
  id: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    cwd,
    name: null,
    preview: `Preview for ${id}`,
    parentThreadId: null,
    ephemeral: false,
    updatedAt: 1_777_000_000,
    status: { type: "notLoaded" },
    ...overrides,
  };
}

function buildAdapter(cwd: string): CodexPtyAdapter {
  return new CodexPtyAdapter({
    kind: "codex",
    command: "codex",
    cwd,
    renderMode: "headless",
  });
}

describe("Codex app-server resume discovery", () => {
  test("filters to recent same-cwd root threads", () => {
    const cwd = path.resolve("tmp/codex-resume-project");
    const candidates = buildCodexResumeCandidatesFromThreadList(
      {
        data: [
          buildThread("thread_old", cwd, {
            preview: "Older preview",
            updatedAt: 1_776_000_000,
          }),
          buildThread("thread_named", cwd, {
            name: "Named thread",
            updatedAt: 1_778_000_000,
          }),
          buildThread("thread_foreign", path.resolve("tmp/other-project")),
          buildThread("thread_subagent", cwd, { parentThreadId: "thread_named" }),
        ],
      },
      cwd,
      8,
    );

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual([
      "thread_named",
      "thread_old",
    ]);
    expect(candidates[0]?.title).toBe("Named thread");
    expect(candidates[1]?.title).toBe("Older preview");
  });

  test("falls back from the state DB to scan-and-repair when the fast list is empty", async () => {
    const cwd = path.resolve("tmp/codex-resume-fallback");
    const adapter = buildAdapter(cwd) as any;
    const requests: Array<Record<string, unknown>> = [];
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe("thread/list");
      requests.push(params);
      return params.useStateDbOnly
        ? { data: [] }
        : { data: [buildThread("thread_found", cwd)] };
    };

    const candidates = await adapter.listResumeSessions(8);

    expect(candidates.map((candidate: { sessionId: string }) => candidate.sessionId)).toEqual([
      "thread_found",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      cwd,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode"],
      useStateDbOnly: true,
    });
    expect(requests[1]?.useStateDbOnly).toBeUndefined();
  });
});

describe("Codex visible thread resume", () => {
  test("commits shared state only after the visible supervisor opens the target", async () => {
    const cwd = path.resolve("tmp/codex-visible-resume");
    const adapter = buildAdapter(cwd) as any;
    const targetThreadId = "019e1505-1c23-7fb1-aee3-c24f89836864";
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const visibleSwitches: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.status = "idle";
    adapter.subscribedThreadIds.add("thread_old");
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "thread/read") {
        return { thread: buildThread(targetThreadId, cwd) };
      }
      if (method === "thread/resume") {
        return {
          thread: buildThread(targetThreadId, cwd, { status: { type: "idle" } }),
        };
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    };
    adapter.switchVisibleCodexThread = async (threadId: string) => {
      visibleSwitches.push(threadId);
      expect(adapter.state.sharedThreadId).toBe("thread_old");
      return threadId;
    };

    await adapter.resumeSession(targetThreadId);

    expect(requests.map((request) => request.method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
    ]);
    expect(visibleSwitches).toEqual([targetThreadId]);
    expect(adapter.state.sharedThreadId).toBe(targetThreadId);
    expect(adapter.state.lastThreadSwitchSource).toBe("wechat");
    expect(adapter.state.lastThreadSwitchReason).toBe("wechat_resume");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread_switched",
        threadId: targetThreadId,
        source: "wechat",
        reason: "wechat_resume",
      }),
    );
  });

  test("keeps the previous thread when the visible supervisor switch fails", async () => {
    const cwd = path.resolve("tmp/codex-visible-rollback");
    const adapter = buildAdapter(cwd) as any;
    const targetThreadId = "019e1505-1c23-7fb1-aee3-c24f89836864";
    const unsubscribed: string[] = [];
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read" || method === "thread/resume") {
        return { thread: buildThread(targetThreadId, cwd) };
      }
      if (method === "thread/unsubscribe") {
        unsubscribed.push(params.threadId as string);
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    };
    adapter.switchVisibleCodexThread = async () => {
      throw new Error("visible switch failed");
    };

    await expect(adapter.resumeSession(targetThreadId)).rejects.toThrow(
      "visible switch failed",
    );

    expect(adapter.state.sharedThreadId).toBe("thread_old");
    expect(adapter.state.status).toBe("idle");
    expect(unsubscribed).toEqual([targetThreadId]);
  });

  test("rejects a target thread that is still active", async () => {
    const cwd = path.resolve("tmp/codex-active-target");
    const adapter = buildAdapter(cwd) as any;
    const targetThreadId = "019e1505-1c23-7fb1-aee3-c24f89836864";
    const methods: string[] = [];
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      methods.push(method);
      return {
        thread: buildThread(targetThreadId, cwd, { status: { type: "active" } }),
      };
    };

    await expect(adapter.resumeSession(targetThreadId)).rejects.toThrow("is still active");
    expect(methods).toEqual(["thread/read"]);
  });

  test("interrupts a WeChat turn and immediately follows a local visible switch", async () => {
    const cwd = path.resolve("tmp/codex-local-follow");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    const interrupts: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_old",
      turnId: "turn_wechat",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_wechat";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      if (method === "turn/interrupt") {
        interrupts.push(params);
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    };

    adapter.handleThreadStatusChanged({
      threadId: "thread_local",
      status: { type: "idle" },
    });
    await Promise.resolve();

    expect(interrupts).toEqual([
      { threadId: "thread_old", turnId: "turn_wechat" },
    ]);
    expect(adapter.activeTurn).toBeNull();
    expect(adapter.state.sharedThreadId).toBe("thread_local");
    expect(adapter.state.status).toBe("idle");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_failed",
        message:
          "The active WeChat task was interrupted because the local Codex terminal switched threads.",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread_switched",
        threadId: "thread_local",
        source: "local",
      }),
    );
  });
});
