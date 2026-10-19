// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocale, initLocaleFromEnv, readLocalePreference, setLocale, t } from "../../src/i18n/index.ts";
import { messages as en } from "../../src/i18n/messages-en.ts";
import { messages as zh } from "../../src/i18n/messages-zh.ts";
import { handleLanguageControl } from "../../src/bridge/language-control.ts";
import { parseBridgeControlCommand } from "../../src/core/bridge-control.ts";
import { formatUserInputRequestMessage, parsePendingUserInputAnswerCommand } from "../../src/bridge/bridge-utils.ts";
import { handleAdapterControl } from "../../src/bridge/adapter-control.ts";
import { WechatDaemon } from "../../src/daemon/wechat-daemon.ts";
import type { BridgeAdapter, PendingUserInputRequest } from "../../src/bridge/bridge-types.ts";
import { isRetryableDeferredCodexDrainError } from "../../src/core/bridge-defer.ts";
import { CodexPtyAdapter } from "../../src/bridge/bridge-adapters.codex.ts";
import { OpenCodeServerAdapter } from "../../src/bridge/bridge-adapters.opencode.ts";

let directory: string;
let originalLanguage: string | undefined;
beforeEach(() => {
  originalLanguage = process.env.CLI_BRIDGE_LANG;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-language-"));
  setLocale("zh");
});
afterEach(() => {
  if (originalLanguage === undefined) delete process.env.CLI_BRIDGE_LANG;
  else process.env.CLI_BRIDGE_LANG = originalLanguage;
  setLocale("zh");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("locale catalogs and selection", () => {
  test("English and Chinese have identical keys and placeholder contracts", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
    for (const key of Object.keys(en)) {
      expect(zh[key].trim().length).toBeGreaterThan(0);
      expect(placeholders(zh[key])).toEqual(placeholders(en[key]));
    }
  });
  test("substitution preserves dollar signs and placeholder-like user content", () => {
    setLocale("en");
    expect(t("session.taskFailed", { adapter: "$&{text}", text: "$'\n{adapter}" }))
      .toBe("$&{text} task failed:\n$'\n{adapter}");
  });
  test("startup uses saved language, with an explicit environment override", () => {
    fs.writeFileSync(path.join(directory, "language.json"), JSON.stringify({ locale: "en" }));
    const env = { ...process.env, CLI_BRIDGE_DATA_DIR: directory };
    delete env.CLI_BRIDGE_LANG;
    const code = 'await import("./src/wechat/channel-config.ts"); const {getLocale}=await import("./src/i18n/index.ts"); process.stdout.write(getLocale());';
    const run = (overrides: NodeJS.ProcessEnv) => execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", code], { env: { ...env, ...overrides }, encoding: "utf8" });
    expect(run({})).toBe("en");
    expect(run({ CLI_BRIDGE_LANG: "zh" })).toBe("zh");
    expect(readLocalePreference(path.join(directory, "language.json"))).toBe("en");
    initLocaleFromEnv({}, "en");
    expect(getLocale()).toBe("en");
  });
});

describe("live language control", () => {
  test("switches language through the real local inbox and outbound transcript", () => {
    const code = `
      import fs from "node:fs";
      import assert from "node:assert/strict";
      import { WechatDaemon } from "./src/daemon/wechat-daemon.ts";
      import { getLocalChannelFiles } from "./src/channels/local/local-driver.ts";
      import { LANGUAGE_FILE } from "./src/wechat/channel-config.ts";
      const cwd = process.env.CLI_BRIDGE_DATA_DIR;
      const localFiles = getLocalChannelFiles(cwd);
      const daemon = new WechatDaemon({ cwd, authorizedUserId: "local-operator", transport: null, channelId: "local", localFiles });
      const outbound = () => fs.existsSync(localFiles.transcriptFile)
        ? fs.readFileSync(localFiles.transcriptFile, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse).filter(line => line.direction === "outbound")
        : [];
      const until = async (predicate) => {
        const deadline = Date.now() + 4000;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error("Local channel reply timed out");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      const send = async (text, expected, senderId = "local-operator") => {
        const before = outbound().length;
        fs.appendFileSync(localFiles.inboxFile, JSON.stringify({ text, senderId }) + "\\n");
        await until(() => outbound().length > before);
        assert.ok(outbound().at(-1).text.includes(expected), outbound().at(-1).text);
      };
      await daemon.startIpcServer();
      const polling = daemon.runPollLoop();
      try {
        await until(() => outbound().length > 0);
        await send("/lang en", "Language switched to en.");
        await send("/lang", "Current language: en");
        await send("/status", "No active terminal is selected.");
        await send("/lang zh", "Unauthorized", "stranger");
        assert.equal(JSON.parse(fs.readFileSync(LANGUAGE_FILE)).locale, "en");
        await send("/lang fr", "Usage:");
        assert.equal(JSON.parse(fs.readFileSync(LANGUAGE_FILE)).locale, "en");
        await send("/language 中文", "语言已切换为 zh。");
        await send("/status", "未选择活跃终端");
        assert.equal(JSON.parse(fs.readFileSync(LANGUAGE_FILE)).locale, "zh");
        assert.equal(daemon.getStatus().slots.length, 0);
      } finally {
        await daemon.shutdown();
        await polling;
      }
      process.stdout.write("local-language-ok");
    `;
    const output = execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", code], {
      env: { ...process.env, CLI_BRIDGE_DATA_DIR: directory, CLI_BRIDGE_LANG: "zh" },
      encoding: "utf8", timeout: 12_000,
    });
    expect(output).toContain("local-language-ok");
  }, 15_000);

  test("parses query, aliases and invalid values as commands, never model input", () => {
    for (const command of ["/lang", "/language"]) {
      expect(parseBridgeControlCommand(command)).toEqual({ type: "language", target: undefined });
      expect(parseBridgeControlCommand(`${command} EN`)).toEqual({ type: "language", target: "EN" });
      expect(parseBridgeControlCommand(`${command} fr`)).toEqual({ type: "language", target: "fr" });
    }
  });
  test("query and invalid values neither write preferences nor synchronize workers", async () => {
    const settingsFile = path.join(directory, "language.json");
    let updates = 0;
    const adapters = [{ updateLocale: async () => { updates++; return true; } }] as unknown as BridgeAdapter[];
    expect(await handleLanguageControl({ settingsFile, adapters })).toContain("当前语言");
    expect(await handleLanguageControl({ target: "fr", settingsFile, adapters })).toContain("用法");
    expect(getLocale()).toBe("zh");
    expect(updates).toBe(0);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
  test("switches all slots while preserving approvals, questions and busy state", async () => {
    const settingsFile = path.join(directory, "language.json");
    const state = { status: "awaiting_input", activeTurnId: "turn-1", pendingApproval: { requestId: "approval-1" }, pendingUserInput: { requestId: "question-1" } };
    const updates: string[] = [];
    const adapters = ["claude", "pi"].map((adapter) => ({
      getState: () => state,
      updateLocale: async (locale: string) => { updates.push(`${adapter}:${locale}`); return true; },
    })) as unknown as BridgeAdapter[];
    const before = JSON.stringify(state);
    expect(await handleLanguageControl({ target: "English", settingsFile, adapters })).toBe("Language switched to en.");
    expect(readLocalePreference(settingsFile)).toBe("en");
    expect(process.env.CLI_BRIDGE_LANG).toBe("en");
    expect(updates).toEqual(["claude:en", "pi:en"]);
    expect(JSON.stringify(state)).toBe(before);
    expect(await handleLanguageControl({ target: "中文", settingsFile, adapters })).toBe("语言已切换为 zh。");
  });
  test("does not change locale on persistence failure and reports older companions", async () => {
    const settingsFile = path.join(directory, "missing", "language.json");
    const before = process.env.CLI_BRIDGE_LANG;
    expect(await handleLanguageControl({ target: "en", settingsFile })).toContain("无法保存");
    expect(getLocale()).toBe("zh");
    expect(process.env.CLI_BRIDGE_LANG).toBe(before);
    const adapters = [{ updateLocale: async () => false }] as unknown as BridgeAdapter[];
    expect(await handleLanguageControl({ target: "en", settingsFile: path.join(directory, "language.json"), adapters })).toContain("Restart those clients");
  });
  test("serializes concurrent switches so saved and companion locales agree", async () => {
    const updates: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const adapters = [{ updateLocale: async (locale: string) => {
      updates.push(locale);
      if (locale === "en") await held;
      return true;
    } }] as unknown as BridgeAdapter[];
    const settingsFile = path.join(directory, "language.json");
    const first = handleLanguageControl({ target: "en", settingsFile, adapters });
    const second = handleLanguageControl({ target: "zh", settingsFile, adapters });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates).toEqual(["en"]);
    release();
    expect(await first).toBe("Language switched to en.");
    expect(await second).toBe("语言已切换为 zh。");
    expect(updates).toEqual(["en", "zh"]);
    expect(readLocalePreference(settingsFile)).toBe(getLocale());
  });
});

test("both locales translate model and question controls without changing upstream option values", async () => {
  const pending: PendingUserInputRequest = {
    requestId: "q", summary: "upstream summary", createdAt: "now",
    questions: [{ id: "q1", header: "Upstream header", question: "Original question", options: [{ label: "Keep $&{value}", description: "Original option" }], multiple: false, isOther: true, customAnswerMode: "value" }],
  };
  const adapter = {
    getState: () => ({ kind: "pi", status: "idle", cwd: directory, command: "pi" }),
    listModels: async () => [{ id: "provider/model", displayName: "Model $&", isCurrent: true }],
    selectModel: async () => ({ id: "provider/model", displayName: "Model $&" }),
    setPlanMode: async (enabled: boolean) => enabled,
  } as unknown as BridgeAdapter;
  for (const locale of ["zh", "en"] as const) {
    setLocale(locale);
    const text = formatUserInputRequestMessage(pending, adapter.getState());
    expect(text).toContain(locale === "zh" ? "选项：" : "options:");
    expect(text).toContain("Original question");
    expect(parsePendingUserInputAnswerCommand("1", pending)).toMatchObject({ answers: { q1: ["Keep $&{value}"] } });
    expect(await handleAdapterControl(adapter, "owner", { type: "model" })).toContain(locale === "zh" ? "可用模型" : "Available Pi models");
    expect(await handleAdapterControl(adapter, "owner", { type: "model", target: "1" })).toContain("Model $&");
    expect(await handleAdapterControl(adapter, "owner", { type: "plan", enabled: true })).toContain(locale === "zh" ? "计划模式已开启" : "plan mode enabled");
  }
});

test("localized adapter rejections retain deferred delivery retry behavior", async () => {
  const codex = new CodexPtyAdapter({ kind: "codex", command: "codex", cwd: directory });
  const opencode = new OpenCodeServerAdapter({ kind: "opencode", command: "opencode", cwd: directory });
  for (const locale of ["zh", "en"] as const) {
    setLocale(locale);
    await expect(codex.listModels()).rejects.toThrow(locale === "zh" ? "需要活动的 app-server 线程" : "requires an active app-server thread");
    await expect(opencode.listModels()).rejects.toThrow(locale === "zh" ? "未运行" : "not running");
    for (const key of ["adapter.codex.busy", "adapter.codex.localBusy", "adapter.codex.approvalPending", "adapter.codex.localInputPending"]) {
      expect(isRetryableDeferredCodexDrainError(t(key))).toBe(true);
    }
    expect(isRetryableDeferredCodexDrainError(t("adapter.codex.notRunning"))).toBe(false);
  }
});
