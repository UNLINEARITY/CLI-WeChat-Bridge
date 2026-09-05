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
  test("lists and selects a model through app-server settings", async () => {
    const cwd = path.resolve("tmp/codex-model-selection");
    const adapter = buildAdapter(cwd) as any;
    adapter.sharedThreadId = "thread_model";
    adapter.state.sharedThreadId = "thread_model";
    adapter.sendRpcRequest = async (method: string) => {
      if (method === "model/list") return { data: [{ id: "gpt-5.2", displayName: "GPT-5.2" }] };
      if (method === "thread/read") return { thread: { model: "gpt-5.1", reasoningEffort: null } };
      if (method === "thread/settings/update") return {};
      throw new Error(`unexpected method ${method}`);
    };

    const models = await adapter.listModels();
    expect(models).toEqual([{ id: "gpt-5.2", displayName: "GPT-5.2", isCurrent: false, supportedReasoningEfforts: undefined }]);
    await expect(adapter.selectModel("gpt-5.2")).resolves.toMatchObject({ id: "gpt-5.2" });
  });

  test("sets and restores Codex plan mode through thread settings", async () => {
    const cwd = path.resolve("tmp/codex-plan-mode");
    const adapter = buildAdapter(cwd) as any;
    adapter.sharedThreadId = "thread_plan";
    adapter.state.sharedThreadId = "thread_plan";
    const updates: Record<string, unknown>[] = [];
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: { model: "gpt-5.2", reasoningEffort: "medium" } };
      if (method === "collaborationMode/list") return { data: [{ name: "Plan", mode: "plan", model: "gpt-5.2" }] };
      if (method === "thread/settings/update") { updates.push(params); return {}; }
      throw new Error(`unexpected method ${method}`);
    };

    await expect(adapter.setPlanMode(true)).resolves.toBe(true);
    await expect(adapter.setPlanMode(false)).resolves.toBe(false);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.collaborationMode).toMatchObject({ mode: "plan" });
    expect(updates[1]?.collaborationMode).toMatchObject({ mode: "default" });
  });

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

  test("rejects a parent-owned multi-agent thread that cannot accept direct input", async () => {
    const cwd = path.resolve("tmp/codex-parent-owned");
    const adapter = buildAdapter(cwd) as any;
    const targetThreadId = "019e1505-1c23-7fb1-aee3-c24f89836864";
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("thread/read");
      return { thread: buildThread(targetThreadId, cwd, { canAcceptDirectInput: false }) };
    };

    await expect(adapter.resumeSession(targetThreadId)).rejects.toThrow("cannot accept direct input");
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
      if (method === "thread/read") {
        return { thread: buildThread("thread_local", cwd) };
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

  test("ignores headless status notifications from another workspace", async () => {
    const cwd = path.resolve("tmp/codex-status-workspace");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("thread/read");
      return { thread: buildThread("thread_foreign", path.resolve("tmp/other-workspace")) };
    };

    adapter.handleThreadStatusChanged({
      threadId: "thread_foreign",
      status: { type: "idle" },
    });
    await Promise.resolve();

    expect(adapter.state.sharedThreadId).toBeUndefined();
    expect(events.filter((event) => event.type === "thread_switched")).toHaveLength(0);
  });

  test("accepts a headless status notification after same-workspace validation", async () => {
    const cwd = path.resolve("tmp/codex-status-workspace-valid");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("thread/read");
      return { thread: buildThread("thread_local", cwd) };
    };

    adapter.handleThreadStatusChanged({
      threadId: "thread_local",
      status: { type: "idle" },
    });
    await Promise.resolve();

    expect(adapter.state.sharedThreadId).toBe("thread_local");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread_switched",
        threadId: "thread_local",
        source: "local",
      }),
    );
  });

  test("subscribes a headless locally followed thread before mirroring its input", async () => {
    const cwd = path.resolve("tmp/codex-local-follow-subscription");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    const methods: string[] = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      methods.push(method);
      if (method === "thread/read" || method === "thread/resume") {
        return { thread: buildThread("thread_local", cwd) };
      }
      throw new Error(`unexpected method ${method}`);
    };

    adapter.handleThreadStatusChanged({
      threadId: "thread_local",
      status: { type: "idle" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(methods).toEqual(["thread/read", "thread/resume"]);
    expect(adapter.subscribedThreadIds.has("thread_local")).toBe(true);

    adapter.handleRpcNotification("turn/started", {
      threadId: "thread_local",
      turnId: "turn_local",
    });
    adapter.handleRpcNotification("item/started", {
      threadId: "thread_local",
      turnId: "turn_local",
      item: {
        type: "userMessage",
        id: "item_local",
        content: [{ type: "text", text: "local input", text_elements: [] }],
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "mirrored_user_input",
        text: "local input",
        origin: "local",
      }),
    );
  });

  test("ignores ephemeral same-workspace status notifications", async () => {
    const cwd = path.resolve("tmp/codex-status-ephemeral");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("thread/read");
      return { thread: buildThread("thread_ephemeral", cwd, { ephemeral: true }) };
    };

    adapter.handleThreadStatusChanged({
      threadId: "thread_ephemeral",
      status: { type: "idle" },
    });
    await Promise.resolve();

    expect(adapter.state.sharedThreadId).toBeUndefined();
    expect(events.filter((event) => event.type === "thread_switched")).toHaveLength(0);
  });

  test("ignores subagent same-workspace status notifications", async () => {
    const cwd = path.resolve("tmp/codex-status-subagent");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.state.status = "idle";
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("thread/read");
      return {
        thread: buildThread("thread_subagent", cwd, { parentThreadId: "thread_root" }),
      };
    };

    adapter.handleThreadStatusChanged({
      threadId: "thread_subagent",
      status: { type: "idle" },
    });
    await Promise.resolve();

    expect(adapter.state.sharedThreadId).toBeUndefined();
    expect(events.filter((event) => event.type === "thread_switched")).toHaveLength(0);
  });

  test("ignores ephemeral and subagent thread-started notifications", () => {
    const cwd = path.resolve("tmp/codex-started-side-threads");
    const adapter = buildAdapter(cwd) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.state.status = "idle";

    adapter.handleThreadStarted({
      thread: buildThread("thread_ephemeral", cwd, { ephemeral: true }),
    });
    adapter.handleThreadStarted({
      thread: buildThread("thread_subagent", cwd, { parentThreadId: "thread_root" }),
    });

    expect(adapter.state.sharedThreadId).toBeUndefined();
    expect(events.filter((event) => event.type === "thread_switched")).toHaveLength(0);
  });

  test("rejects an ephemeral saved thread during startup restore", async () => {
    const cwd = path.resolve("tmp/codex-startup-ephemeral");
    const adapter = buildAdapter(cwd) as any;
    adapter.sendRpcRequest = async (method: string) => {
      expect(method).toBe("thread/resume");
      return { thread: buildThread("thread_ephemeral", cwd, { ephemeral: true }) };
    };

    await expect(
      adapter.resumeSharedThread("thread_ephemeral", { startup: true }),
    ).rejects.toThrow("is ephemeral");
    expect(adapter.state.sharedThreadId).toBeUndefined();
  });

  test("ignores late weak thread signals immediately after a WeChat reply", async () => {
    const cwd = path.resolve("tmp/codex-late-thread-follow");
    const adapter = buildAdapter(cwd) as any;
    const trackedTurn = {
      threadId: "thread_current",
      turnId: "turn_wechat",
      origin: "wechat",
    };
    adapter.sharedThreadId = "thread_current";
    adapter.announcedThreadId = "thread_current";
    adapter.state.sharedThreadId = "thread_current";
    adapter.state.sharedSessionId = "thread_current";
    adapter.state.status = "busy";
    adapter.activeTurn = trackedTurn;
    adapter.state.activeTurnId = trackedTurn.turnId;
    adapter.state.activeTurnOrigin = trackedTurn.origin;
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") {
        return { thread: buildThread(String(params.threadId), cwd) };
      }
      throw new Error(`unexpected method ${method}`);
    };
    adapter.turnFinalMessages.set(
      trackedTurn.turnId,
      new Map([["item_final", "done"]]),
    );

    adapter.handleTurnCompleted(trackedTurn, {
      turn: { status: "completed" },
    });
    adapter.handleThreadStatusChanged({
      threadId: "thread_late_status",
      status: { type: "idle" },
    });
    adapter.handleThreadStarted({
      thread: buildThread("thread_late_started", cwd, {
        status: { type: "idle" },
      }),
    });

    expect(adapter.state.sharedThreadId).toBe("thread_current");

    adapter.localThreadFollowBlockedUntilMs = Date.now() - 1;
    adapter.handleThreadStatusChanged({
      threadId: "thread_real_local",
      status: { type: "idle" },
    });

    await Promise.resolve();

    expect(adapter.state.sharedThreadId).toBe("thread_real_local");
  });

  test("does not treat resume replay status as a local thread switch", () => {
    const cwd = path.resolve("tmp/codex-resume-replay");
    const adapter = buildAdapter(cwd) as any;
    adapter.sharedThreadId = "thread_old";
    adapter.state.sharedThreadId = "thread_old";
    adapter.state.sharedSessionId = "thread_old";
    adapter.state.status = "idle";
    adapter.subscribedThreadIds.add("thread_target");
    adapter.bridgeResumeReplayThreadId = "thread_target";
    adapter.bridgeResumeReplayUntilMs = Date.now() + 5_000;

    adapter.handleThreadStatusChanged({
      threadId: "thread_target",
      status: { type: "idle" },
    });

    expect(adapter.state.sharedThreadId).toBe("thread_old");

    adapter.bridgeResumeReplayUntilMs = Date.now() - 1;
    adapter.handleThreadStatusChanged({
      threadId: "thread_target",
      status: { type: "idle" },
    });
    expect(adapter.state.sharedThreadId).toBe("thread_target");
  });
});
