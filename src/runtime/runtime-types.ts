// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type {
  LegacyBridgeAdapterKind,
  BridgeAdapter,
  BridgeWorkerStatus,
} from "../bridge/bridge-types.ts";

export const LOCAL_CLIENT_PROTOCOL_VERSION = 2;
export const CODEX_REMOTE_AUTH_TOKEN_ENV = "WECHAT_BRIDGE_CODEX_REMOTE_AUTH_TOKEN";

export type RuntimeKind = "legacy_adapter" | "codex_runtime_host";
export type RuntimeRenderMode = "embedded" | "panel" | "companion" | "headless";

export type LocalClientEndpoint = {
  protocolVersion: number;
  runtimeKind: RuntimeKind;
  instanceId: string;
  kind: LegacyBridgeAdapterKind;
  port: number;
  token: string;
  renderMode?: RuntimeRenderMode;
  bridgeOwnerPid?: number;
  serverPort?: number;
  serverUrl?: string;
  remoteAuthTokenEnv?: string;
  codexControlPort?: number;
  codexControlToken?: string;
  codexVisibleThreadId?: string;
  cwd: string;
  command: string;
  profile?: string;
  sharedSessionId?: string;
  sharedThreadId?: string;
  resumeConversationId?: string;
  transcriptPath?: string;
  companionPid?: number;
  companionConnectedAt?: string;
  companionStatus?: BridgeWorkerStatus;
  companionLastStateAt?: string;
  companionWorkerPid?: number;
  startedAt: string;
};

export interface LocalClientEndpointProvider {
  getLocalClientEndpoint(): LocalClientEndpoint | null;
}

export interface VisibleClientSessionPreparer {
  prepareVisibleClientSession(): Promise<boolean>;
}

export interface RuntimeHost extends BridgeAdapter {
  readonly runtimeKind: RuntimeKind;
}

export function hasLocalClientEndpointProvider(
  runtime: BridgeAdapter,
): runtime is BridgeAdapter & LocalClientEndpointProvider {
  return typeof (runtime as Partial<LocalClientEndpointProvider>).getLocalClientEndpoint === "function";
}

export function hasVisibleClientSessionPreparer(
  runtime: BridgeAdapter,
): runtime is BridgeAdapter & VisibleClientSessionPreparer {
  return typeof (runtime as Partial<VisibleClientSessionPreparer>).prepareVisibleClientSession === "function";
}
