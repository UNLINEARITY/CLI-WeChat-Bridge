import type { BridgeAdapter } from "./bridge-types.ts";
import { ClaudeCompanionAdapter } from "./bridge-adapters.claude.ts";
import { LocalCompanionProxyAdapter } from "./bridge-adapters.core.ts";
import { CodexPtyAdapter } from "./bridge-adapters.codex.ts";
import { OpenCodeServerAdapter } from "./bridge-adapters.opencode.ts";
import { PiTuiAdapter } from "./bridge-adapters.pi.ts";
import type { AdapterOptions } from "./bridge-adapters.shared.ts";

export * from "./bridge-adapters.shared.ts";

export function createBridgeAdapter(options: AdapterOptions): BridgeAdapter {
  switch (options.kind) {
    case "codex":
      return options.renderMode === "panel"
        ? new CodexPtyAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "claude":
      return options.renderMode === "companion"
        ? new ClaudeCompanionAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "opencode":
      return options.renderMode === "companion"
        ? new OpenCodeServerAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    case "pi":
      return options.renderMode === "companion"
        ? new PiTuiAdapter(options)
        : new LocalCompanionProxyAdapter(options);
    default:
      throw new Error(`Unsupported adapter: ${options.kind}`);
  }
}
