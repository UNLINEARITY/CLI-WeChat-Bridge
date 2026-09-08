import { describe, expect, test } from "bun:test";

import { OpenCodeServerAdapter } from "../../src/bridge/bridge-adapters.opencode.ts";

function result<T>(data: T) {
  return { data, error: undefined, request: {}, response: {} };
}

function session(
  id: string,
  selection: {
    agent?: string;
    model?: { id: string; providerID: string; variant?: string };
  } = {},
) {
  return {
    id,
    projectID: "project_1",
    directory: process.cwd(),
    title: id,
    version: "1.18.18",
    time: { created: Date.now(), updated: Date.now() },
    ...selection,
  };
}

describe("OpenCode API controls", () => {
  test("lists and switches models through the session API while preserving a supported variant", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const current = session("session_model", {
      agent: "build",
      model: { providerID: "provider_1", id: "model_1", variant: "high" },
    });
    const switches: Array<Record<string, unknown>> = [];
    const internal = adapter as unknown as {
      state: { status: string };
      activeSessionId: string | null;
      client: unknown;
    };
    internal.state.status = "idle";
    internal.activeSessionId = current.id;
    internal.client = {
      provider: {
        list: async () => result({
          connected: ["provider_1"],
          all: [{
            id: "provider_1",
            name: "Provider One",
            models: {
              model_1: { id: "model_1", name: "Model One", variants: { high: {} } },
              model_2: { id: "model_2", name: "Model Two", variants: { high: {}, low: {} } },
              model_3: { id: "model_3", name: "Model Three" },
            },
          }],
        }),
      },
      session: {
        get: async () => result(current),
      },
      v2: {
        session: {
          switchModel: async (options: { model: typeof current.model }) => {
            switches.push(options as unknown as Record<string, unknown>);
            current.model = options.model;
            return result(undefined);
          },
        },
      },
    };

    await expect(adapter.listModels()).resolves.toEqual([
      { id: "provider_1/model_1", displayName: "Model One (Provider One)", isCurrent: true },
      { id: "provider_1/model_2", displayName: "Model Two (Provider One)", isCurrent: false },
      { id: "provider_1/model_3", displayName: "Model Three (Provider One)", isCurrent: false },
    ]);
    await expect(adapter.selectModel("provider_1/model_2")).resolves.toEqual({
      id: "provider_1/model_2",
      displayName: "Model Two (Provider One)",
      isCurrent: true,
    });
    await expect(adapter.selectModel("provider_1/model_3")).resolves.toEqual({
      id: "provider_1/model_3",
      displayName: "Model Three (Provider One)",
      isCurrent: true,
    });
    expect(switches).toEqual([
      {
        sessionID: "session_model",
        model: { providerID: "provider_1", id: "model_2", variant: "high" },
      },
      {
        sessionID: "session_model",
        model: { providerID: "provider_1", id: "model_3", variant: "default" },
      },
    ]);
  });

  test("enables plan and restores the previous primary agent without terminal input", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const current = session("session_plan", { agent: "review" });
    const switches: string[] = [];
    const internal = adapter as unknown as {
      state: { status: string };
      activeSessionId: string | null;
      client: unknown;
    };
    internal.state.status = "idle";
    internal.activeSessionId = current.id;
    internal.client = {
      app: {
        agents: async () => result([
          { name: "build", mode: "primary" },
          { name: "plan", mode: "primary" },
          { name: "review", mode: "primary" },
          { name: "hidden", mode: "primary", hidden: true },
          { name: "helper", mode: "subagent" },
        ]),
      },
      session: {
        get: async () => result(current),
      },
      v2: {
        session: {
          switchAgent: async (options: { agent: string }) => {
            switches.push(options.agent);
            current.agent = options.agent;
            return result(undefined);
          },
        },
      },
    };

    await expect(adapter.setPlanMode(true)).resolves.toBe(true);
    await expect(adapter.setPlanMode(true)).resolves.toBe(true);
    await expect(adapter.setPlanMode(false)).resolves.toBe(false);
    expect(switches).toEqual(["plan", "review"]);
  });

  test("submits companion prompts through the SDK with committed model and plan state", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
      renderMode: "companion",
    });
    const current = session("session_prompt", {
      agent: "plan",
      model: { providerID: "provider_1", id: "model_2", variant: "high" },
    });
    let prompt: Record<string, unknown> | undefined;
    const internal = adapter as unknown as {
      state: { status: string };
      activeSessionId: string | null;
      pendingLocalPrompt: string;
      nativeProcess: unknown;
      client: unknown;
    };
    internal.state.status = "idle";
    internal.activeSessionId = current.id;
    internal.pendingLocalPrompt = "unsent local draft";
    internal.nativeProcess = {};
    internal.client = {
      session: {
        get: async () => result(current),
        promptAsync: async (options: Record<string, unknown>) => {
          prompt = options;
          return result(undefined);
        },
      },
      tui: {
        selectSession: async () => result(true),
      },
    };

    await adapter.sendInput("hello from wechat");

    expect(prompt).toMatchObject({
      sessionID: current.id,
      directory: process.cwd(),
      agent: "plan",
      model: { providerID: "provider_1", modelID: "model_2" },
      variant: "high",
      parts: [{ type: "text", text: "hello from wechat" }],
    });
  });

  test("does not report a model switch when the server does not commit it", async () => {
    const adapter = new OpenCodeServerAdapter({
      kind: "opencode",
      command: "opencode",
      cwd: process.cwd(),
    });
    const current = session("session_rejected", {
      model: { providerID: "provider_1", id: "model_1", variant: "default" },
    });
    const internal = adapter as unknown as {
      state: { status: string };
      activeSessionId: string | null;
      client: unknown;
    };
    internal.state.status = "idle";
    internal.activeSessionId = current.id;
    internal.client = {
      provider: {
        list: async () => result({
          connected: ["provider_1"],
          all: [{
            id: "provider_1",
            name: "Provider One",
            models: {
              model_1: { id: "model_1", name: "Model One" },
              model_2: { id: "model_2", name: "Model Two" },
            },
          }],
        }),
      },
      session: {
        get: async () => result(current),
      },
      v2: {
        session: {
          switchModel: async () => result(undefined),
        },
      },
    };

    await expect(adapter.selectModel("provider_1/model_2")).rejects.toThrow(
      "OpenCode did not confirm the selected model.",
    );
  });
});
