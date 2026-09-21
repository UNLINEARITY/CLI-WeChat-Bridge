// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import {
  LOCAL_COMPANION_RECONNECT_RETRY_MS,
  shouldReconnectLocalCompanion,
} from "../../src/companion/local-companion.ts";

describe("local companion reconnect policy", () => {
  test("reconnects only for unexpected bridge disconnects", () => {
    expect(
      shouldReconnectLocalCompanion({
        shuttingDown: false,
        closeReason: null,
      }),
    ).toBe(true);

    expect(
      shouldReconnectLocalCompanion({
        shuttingDown: true,
        closeReason: null,
      }),
    ).toBe(false);

    expect(
      shouldReconnectLocalCompanion({
        shuttingDown: false,
        closeReason: "worker_exit",
      }),
    ).toBe(false);
  });

  test("keeps reconnect retries short for the grace window loop", () => {
    expect(LOCAL_COMPANION_RECONNECT_RETRY_MS).toBe(250);
  });
});
