import type { BridgeAdapter, BridgeModelOption } from "./bridge-types.ts";

type ControlCommand = { type: "model"; target?: string } | { type: "plan"; enabled: boolean };
type ModelSnapshot = {
  owner: string;
  createdAtMs: number;
  models: BridgeModelOption[];
};
const snapshots = new WeakMap<BridgeAdapter, ModelSnapshot>();
export const MODEL_SNAPSHOT_TTL_MS = 5 * 60_000;

export function invalidateModelSnapshot(adapter: BridgeAdapter): void {
  snapshots.delete(adapter);
}

function snapshotOwner(adapter: BridgeAdapter, senderId: string): string {
  const state = adapter.getState();
  return JSON.stringify([
    senderId, state.kind, state.cwd, state.pid, state.startedAt,
    state.resumeConversationId ?? state.sharedSessionId ?? state.sharedThreadId,
    state.lastSessionSwitchAt ?? state.lastThreadSwitchAt,
  ]);
}

export async function handleAdapterControl(
  adapter: BridgeAdapter,
  senderId: string,
  command: ControlCommand,
): Promise<string> {
  const kind = adapter.getState().kind;
  const name = kind === "claude" ? "Claude Code" : kind === "opencode" ? "OpenCode" : kind === "codex" ? "Codex" : "Pi";
  try {
    if (kind === "pi") throw new Error(`/${command.type} is not available for ${name}.`);
    if (command.type === "plan") {
      if (!adapter.setPlanMode) throw new Error(`Plan mode is not available for ${name}.`);
      const enabled = await adapter.setPlanMode(command.enabled);
      return enabled
        ? `${name} plan mode enabled. Send /plan off to restore the previous mode.`
        : `${name} plan mode disabled.`;
    }
    if (!adapter.listModels || !adapter.selectModel) throw new Error(`Model selection is not available for ${name}.`);
    const owner = snapshotOwner(adapter, senderId);
    if (!command.target) {
      snapshots.delete(adapter);
      const models = await adapter.listModels();
      if (snapshotOwner(adapter, senderId) !== owner) throw new Error("The active session changed. Send /model again.");
      if (!models.length) return `${name} did not return any available models.`;
      snapshots.set(adapter, { owner, createdAtMs: Date.now(), models });
      return [
        `Available ${name} models:`, "",
        ...models.map((model, index) => `${index + 1}. ${model.displayName}${model.isCurrent ? "  (current)" : ""}`),
        "", "Reply with /model <number> to switch. The list is valid for 5 minutes.",
      ].join("\n");
    }
    const snapshot = snapshots.get(adapter);
    if (!snapshot || snapshot.owner !== owner || Date.now() - snapshot.createdAtMs > MODEL_SNAPSHOT_TTL_MS) {
      throw new Error("The model list has expired or belongs to another session. Send /model again.");
    }
    const index = Number(command.target);
    if (!/^\d+$/.test(command.target) || !Number.isSafeInteger(index) || index < 1 || index > snapshot.models.length) {
      throw new Error("Model selection is outside the displayed range. Send /model again to refresh the list.");
    }
    const model = await adapter.selectModel(snapshot.models[index - 1]!.id);
    snapshots.delete(adapter);
    return `${name} model switched to ${model.displayName}.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
