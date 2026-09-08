import { describe, expect, test } from "bun:test";
import { handleAdapterControl, invalidateModelSnapshot } from "../../src/bridge/adapter-control.ts";
import type { BridgeAdapter, BridgeAdapterState } from "../../src/bridge/bridge-types.ts";
import { LegacyAdapterRuntime } from "../../src/runtime/legacy-adapter-runtime.ts";

function fixture(kind: BridgeAdapterState["kind"] = "opencode") {
  const state: BridgeAdapterState = { kind, cwd: "workspace", command: kind, status: "idle", pid: 123, sharedSessionId: "session-1" };
  const selected: string[] = [];
  const plans: boolean[] = [];
  const adapter = {
    getState: () => ({ ...state }),
    listModels: async () => [{ id: "provider/model", displayName: "Model (provider)", isCurrent: true }],
    selectModel: async (id: string) => { selected.push(id); return { id, displayName: "Model (provider)" }; },
    setPlanMode: async (enabled: boolean) => { plans.push(enabled); return enabled; },
  } as unknown as BridgeAdapter;
  return { adapter, state, selected, plans };
}

describe("shared adapter model and plan commands", () => {
  for (const kind of ["codex", "claude", "opencode"] as const) {
    test(`${kind} lists and selects through the runtime wrapper`, async () => {
      const f = fixture(kind);
      const runtime = new LegacyAdapterRuntime(f.adapter);
      expect(await handleAdapterControl(runtime, "user", { type: "model" })).toContain("1. Model (provider)  (current)");
      expect(await handleAdapterControl(runtime, "user", { type: "model", target: "1" })).toContain("model switched");
      expect(f.selected).toEqual(["provider/model"]);
      expect(await handleAdapterControl(runtime, "user", { type: "plan", enabled: true })).toContain("plan mode enabled");
      expect(await handleAdapterControl(runtime, "user", { type: "plan", enabled: false })).toContain("plan mode disabled");
      expect(f.plans).toEqual([true, false]);
    });
  }

  test("rejects selection without a list, invalid numbers, another sender and changed sessions", async () => {
    const f = fixture();
    expect(await handleAdapterControl(f.adapter, "u", { type: "model", target: "1" })).toContain("Send /model again");
    await handleAdapterControl(f.adapter, "u", { type: "model" });
    for (const target of ["0", "2", "1.0", "1e0", "no", "-1"]) {
      expect(await handleAdapterControl(f.adapter, "u", { type: "model", target })).toContain("outside the displayed range");
    }
    expect(await handleAdapterControl(f.adapter, "other", { type: "model", target: "1" })).toContain("another session");
    f.state.sharedSessionId = "session-2";
    expect(await handleAdapterControl(f.adapter, "u", { type: "model", target: "1" })).toContain("another session");
    expect(f.selected).toEqual([]);
  });

  test("invalidates on process replacement, daemon switching and TTL expiry", async () => {
    const f = fixture();
    await handleAdapterControl(f.adapter, "u", { type: "model" });
    f.state.pid = 456;
    expect(await handleAdapterControl(f.adapter, "u", { type: "model", target: "1" })).toContain("expired");
    await handleAdapterControl(f.adapter, "u", { type: "model" });
    invalidateModelSnapshot(f.adapter);
    expect(await handleAdapterControl(f.adapter, "u", { type: "model", target: "1" })).toContain("expired");
    await handleAdapterControl(f.adapter, "u", { type: "model" });
    const now = Date.now;
    const start = now();
    Date.now = () => start + 300_001;
    try {
      expect(await handleAdapterControl(f.adapter, "u", { type: "model", target: "1" })).toContain("expired");
    } finally { Date.now = now; }
    expect(f.selected).toEqual([]);
  });

  test("does not save a list obtained across a session switch or report failed changes as success", async () => {
    const f = fixture("claude");
    f.adapter.listModels = async () => { f.state.sharedSessionId = "changed"; return []; };
    expect(await handleAdapterControl(f.adapter, "u", { type: "model" })).toContain("active session changed");
    f.adapter.setPlanMode = async () => { throw new Error("Native selector disconnected"); };
    expect(await handleAdapterControl(f.adapter, "u", { type: "plan", enabled: true })).toBe("Native selector disconnected");
  });

  test("Pi remains explicitly unsupported", async () => {
    const f = fixture("pi");
    expect(await handleAdapterControl(f.adapter, "u", { type: "model" })).toContain("not available for Pi");
    expect(await handleAdapterControl(f.adapter, "u", { type: "plan", enabled: true })).toContain("not available for Pi");
    expect(f.plans).toEqual([]);
  });
});
