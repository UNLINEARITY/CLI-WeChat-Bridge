import {
  clearLocalCompanionEndpoint,
  readLocalCompanionEndpoint,
  writeLocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";
import type { BridgeAdapter } from "./bridge-types.ts";
import { hasLocalClientEndpointProvider } from "../runtime/runtime-types.ts";

export class BridgeController {
  private endpointInstanceId: string | null = null;
  private readonly adapter: BridgeAdapter;
  private readonly cwd: string;

  constructor(adapter: BridgeAdapter, cwd: string) {
    this.adapter = adapter;
    this.cwd = cwd;
  }

  syncLocalClientEndpoint(): void {
    if (!hasLocalClientEndpointProvider(this.adapter)) {
      return;
    }

    const endpoint = this.adapter.getLocalClientEndpoint();
    if (!endpoint) {
      this.clearLocalClientEndpoint();
      return;
    }

    const existing = readLocalCompanionEndpoint(this.cwd, {
      adapter: endpoint.kind,
    });
    const adapterState = this.adapter.getState();
    const nextEndpoint =
      existing?.instanceId === endpoint.instanceId
        ? {
            ...endpoint,
            companionPid: endpoint.companionPid ?? existing.companionPid,
            companionConnectedAt:
              endpoint.companionConnectedAt ?? existing.companionConnectedAt,
            companionStatus: adapterState.status,
            companionLastStateAt: new Date().toISOString(),
            companionWorkerPid: adapterState.pid,
          }
        : {
            ...endpoint,
            companionStatus: adapterState.status,
            companionLastStateAt: new Date().toISOString(),
            companionWorkerPid: adapterState.pid,
          };

    this.endpointInstanceId = endpoint.instanceId;
    writeLocalCompanionEndpoint(nextEndpoint);
  }

  clearLocalClientEndpoint(): void {
    clearLocalCompanionEndpoint(this.cwd, this.endpointInstanceId ?? undefined, {
      adapter: this.adapter.getState().kind,
    });
    this.endpointInstanceId = null;
  }
}
