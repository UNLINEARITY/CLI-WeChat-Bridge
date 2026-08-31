import { describe, expect, test } from "bun:test";

import {
  CodexPtyAdapter,
  isCodexVersionInCompatibilityRange,
  parseCodexCliVersion,
  shouldSuppressCodexTransportFatalError,
  shouldTreatCodexNativeExitAsExpected,
} from "../../src/bridge/bridge-adapters.codex.ts";

describe("Codex version compatibility", () => {
  test("parses the installed Codex CLI version", () => {
    expect(parseCodexCliVersion("codex-cli 0.151.0\n")).toBe("0.151.0");
  });

  test("accepts the validated Codex 0.149 through 0.151 range", () => {
    expect(isCodexVersionInCompatibilityRange("0.149.1")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.151.0")).toBe(true);
    expect(isCodexVersionInCompatibilityRange("0.152.0")).toBe(false);
  });
});

describe("codex exit handling", () => {
  test("treats a clean native panel exit as expected", () => {
    expect(
      shouldTreatCodexNativeExitAsExpected({
        renderMode: "panel",
        shuttingDown: false,
        exitCode: 0,
      }),
    ).toBe(true);
  });

  test("keeps embedded codex exit code 0 as unexpected", () => {
    expect(
      shouldTreatCodexNativeExitAsExpected({
        renderMode: "embedded",
        shuttingDown: false,
        exitCode: 0,
      }),
    ).toBe(false);
  });

  test("suppresses transport fatal errors while a clean panel exit is in progress", () => {
    expect(
      shouldSuppressCodexTransportFatalError({
        transportShuttingDown: false,
        shuttingDown: false,
        cleanPanelExitInProgress: true,
      }),
    ).toBe(true);
  });

  test("keeps the fatal tail of the app-server log", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    adapter.appServerLog = `${"startup ".repeat(80)}\nactual fatal detail`;

    const details = adapter.describeAppServerLog();

    expect(details).toContain("actual fatal detail");
    expect(details.length).toBeLessThan(560);
  });
});
