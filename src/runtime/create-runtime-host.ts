// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { createBridgeAdapter } from "../bridge/bridge-adapters.ts";
import { CodexPtyAdapter } from "../bridge/bridge-adapters.codex.ts";
import type { AdapterOptions } from "../bridge/bridge-adapters.shared.ts";
import { LegacyAdapterRuntime } from "./legacy-adapter-runtime.ts";
import type { RuntimeHost } from "./runtime-types.ts";

export function createRuntimeHost(options: AdapterOptions): RuntimeHost {
  if (options.kind === "codex") {
    return new CodexPtyAdapter({
      ...options,
      renderMode: options.renderMode ?? "headless",
    });
  }

  return new LegacyAdapterRuntime(createBridgeAdapter(options));
}
