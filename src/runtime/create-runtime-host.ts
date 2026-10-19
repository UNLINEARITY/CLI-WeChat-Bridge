// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { createBridgeAdapter } from "../bridge/bridge-adapters.ts";
import { CodexPtyAdapter } from "../bridge/bridge-adapters.codex.ts";
import type { AdapterOptions } from "../bridge/bridge-adapters.shared.ts";
import type { BridgeAdapter } from "../bridge/bridge-types.ts";

/**
 * The runtime a daemon slot drives: Codex hosts its own app-server in the
 * daemon; the other CLIs are reached through their visible companion.
 */
export function createRuntimeHost(options: AdapterOptions): BridgeAdapter {
  if (options.kind === "codex") {
    return new CodexPtyAdapter({
      ...options,
      renderMode: options.renderMode ?? "headless",
    });
  }

  return createBridgeAdapter(options);
}
