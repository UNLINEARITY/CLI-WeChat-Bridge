import type { CodexModelOption } from "./bridge-types.ts";

export const CODEX_MODEL_SNAPSHOT_TTL_MS = 5 * 60_000;

export type CodexModelSnapshot = {
  createdAtMs: number;
  threadId?: string;
  models: CodexModelOption[];
};

export function formatCodexModelList(models: CodexModelOption[]): string {
  if (models.length === 0) return "Codex did not return any available models.";
  const lines = ["Available Codex models:", ""];
  models.forEach((model, index) => {
    lines.push(`${index + 1}. ${model.displayName}${model.isCurrent ? "  (current)" : ""}`);
  });
  lines.push("", "Reply with /model <number> to switch. The list is valid for 5 minutes.");
  return lines.join("\n");
}

export function selectCodexModel(snapshot: CodexModelSnapshot | null, target: string, now = Date.now()): CodexModelOption {
  if (!snapshot || now - snapshot.createdAtMs > CODEX_MODEL_SNAPSHOT_TTL_MS) {
    throw new Error("The Codex model list has expired. Send /model again before choosing a number.");
  }
  const index = Number(target);
  if (!Number.isInteger(index) || index < 1 || index > snapshot.models.length) {
    throw new Error(`Model selection ${target} is outside the displayed range. Send /model again to refresh the list.`);
  }
  return snapshot.models[index - 1]!;
}
