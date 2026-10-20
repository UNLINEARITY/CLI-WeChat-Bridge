// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { describe, expect, test } from "bun:test";

import {
  NO_BRIDGE_MODE,
  admitWindow,
  modeAfterWindowClosed,
  modeAllowsCommand,
  nextInstance,
  windowSourceName,
  type BridgeMode,
  type BridgeWindow,
} from "../../src/daemon/bridge-mode.ts";

const A = "/work/a";
const B = "/work/b";
const label = (cwd: string) => cwd.split("/").pop()!;

const single: BridgeMode = { kind: "single", anchorCwd: A, adapter: "pi" };
const multiType: BridgeMode = { kind: "multi_type", anchorCwd: A };
const multiInstance: BridgeMode = { kind: "multi_instance", anchorCwd: A, adapter: "pi" };
const multiWorkspace: BridgeMode = { kind: "multi_workspace" };

describe("admitWindow", () => {
  test("the first window starts a clean single bridge", () => {
    expect(admitWindow(NO_BRIDGE_MODE, [], { cwd: A, adapter: "pi" })).toEqual({
      admitted: true,
      mode: single,
      instance: 1,
    });
  });

  test("L0 upgrades to L1 on another type in the anchor workspace", () => {
    expect(admitWindow(single, [{ cwd: A, adapter: "pi", instance: 1 }], { cwd: A, adapter: "opencode" }))
      .toEqual({ admitted: true, mode: multiType, instance: 1, upgradedTo: "multi_type" });
  });

  test("L0 upgrades to L2 on the same type in the anchor workspace", () => {
    expect(admitWindow(single, [{ cwd: A, adapter: "pi", instance: 1 }], { cwd: A, adapter: "pi" }))
      .toEqual({ admitted: true, mode: multiInstance, instance: 2, upgradedTo: "multi_instance" });
  });

  test("any level upgrades to L3 on a window in another workspace", () => {
    for (const mode of [single, multiType, multiInstance]) {
      expect(admitWindow(mode, [{ cwd: A, adapter: "pi", instance: 1 }], { cwd: B, adapter: "pi" }))
        .toEqual({ admitted: true, mode: multiWorkspace, instance: 1, upgradedTo: "multi_workspace" });
    }
  });

  test("L1 admits new types and refuses a type the workspace already runs", () => {
    const windows: BridgeWindow[] = [
      { cwd: A, adapter: "pi", instance: 1 },
      { cwd: A, adapter: "codex", instance: 1 },
    ];
    expect(admitWindow(multiType, windows, { cwd: A, adapter: "claude" }))
      .toEqual({ admitted: true, mode: multiType, instance: 1 });
    expect(admitWindow(multiType, windows, { cwd: A, adapter: "pi" }))
      .toEqual({ admitted: false, reason: "type_already_open" });
  });

  test("L2 admits the locked type with the lowest free number and refuses others", () => {
    const windows: BridgeWindow[] = [
      { cwd: A, adapter: "pi", instance: 1 },
      { cwd: A, adapter: "pi", instance: 3 },
    ];
    expect(admitWindow(multiInstance, windows, { cwd: A, adapter: "pi" }))
      .toEqual({ admitted: true, mode: multiInstance, instance: 2 });
    expect(admitWindow(multiInstance, windows, { cwd: A, adapter: "codex" }))
      .toEqual({ admitted: false, reason: "instance_mode_type_locked" });
  });

  test("L3 admits anything and numbers repeats per workspace and type", () => {
    const windows: BridgeWindow[] = [
      { cwd: A, adapter: "pi", instance: 1 },
      { cwd: B, adapter: "codex", instance: 1 },
    ];
    expect(admitWindow(multiWorkspace, windows, { cwd: A, adapter: "codex" }))
      .toEqual({ admitted: true, mode: multiWorkspace, instance: 1 });
    expect(admitWindow(multiWorkspace, windows, { cwd: B, adapter: "codex" }))
      .toEqual({ admitted: true, mode: multiWorkspace, instance: 2 });
  });
});

describe("nextInstance", () => {
  test("reuses the lowest gap within one workspace and type", () => {
    const windows: BridgeWindow[] = [
      { cwd: A, adapter: "pi", instance: 1 },
      { cwd: A, adapter: "pi", instance: 3 },
      { cwd: B, adapter: "pi", instance: 2 },
      { cwd: A, adapter: "codex", instance: 2 },
    ];
    expect(nextInstance(windows, A, "pi")).toBe(2);
    expect(nextInstance(windows, B, "pi")).toBe(1);
    expect(nextInstance(windows, A, "codex")).toBe(1);
  });
});

describe("modeAfterWindowClosed", () => {
  test("never steps down while windows remain", () => {
    expect(modeAfterWindowClosed(multiInstance, 1, false)).toEqual(multiInstance);
    expect(modeAfterWindowClosed(multiType, 1, true)).toEqual(multiType);
  });

  test("a resident daemon starts over once its last window closed", () => {
    expect(modeAfterWindowClosed(multiWorkspace, 0, true)).toEqual(NO_BRIDGE_MODE);
    expect(modeAfterWindowClosed(multiWorkspace, 0, false)).toEqual(multiWorkspace);
  });
});

describe("modeAllowsCommand", () => {
  test("exposes each command only where it has a meaning", () => {
    const table = [NO_BRIDGE_MODE, single, multiType, multiInstance, multiWorkspace].map((mode) =>
      [mode.kind, ["cd", "all", "instance", "open"].filter((command) =>
        modeAllowsCommand(mode, command as "cd"))]);
    expect(table).toEqual([
      ["none", []],
      ["single", ["open"]],
      ["multi_type", ["all"]],
      ["multi_instance", ["all", "instance", "open"]],
      ["multi_workspace", ["cd", "all", "instance", "open"]],
    ]);
  });
});

describe("windowSourceName", () => {
  test("names windows per mode", () => {
    const pi1: BridgeWindow = { cwd: A, adapter: "pi", instance: 1 };
    const pi2: BridgeWindow = { cwd: A, adapter: "pi", instance: 2 };
    const codex: BridgeWindow = { cwd: B, adapter: "codex", instance: 1 };
    expect(windowSourceName(single, pi1, [pi1], label)).toBeNull();
    expect(windowSourceName(multiType, pi1, [pi1], label)).toBe("pi");
    expect(windowSourceName(multiInstance, pi1, [pi1], label)).toBe("pi-1");
    expect(windowSourceName(multiWorkspace, pi1, [pi1, pi2, codex], label)).toBe("a/pi-1");
    expect(windowSourceName(multiWorkspace, pi1, [pi1, codex], label)).toBe("a/pi");
    expect(windowSourceName(multiWorkspace, codex, [pi1, codex], label)).toBe("b/codex");
  });
});
