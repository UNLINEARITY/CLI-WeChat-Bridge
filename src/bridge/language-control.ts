// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { getLocale, parseLocale, setLocale, t } from "../i18n/index.ts";
import { writeJsonFileAtomic } from "../utils/atomic-file.ts";
import type { BridgeAdapter } from "./bridge-types.ts";

type LanguageControlParams = {
  target?: string;
  settingsFile: string;
  adapters?: BridgeAdapter[];
};
let languageChangeChain: Promise<unknown> = Promise.resolve();

/** Language changes never touch turn ownership or pending interactions. */
export function handleLanguageControl(params: LanguageControlParams): Promise<string> {
  const run = languageChangeChain.then(() => applyLanguageControl(params));
  languageChangeChain = run.catch(() => undefined);
  return run;
}

async function applyLanguageControl(params: LanguageControlParams): Promise<string> {
  if (!params.target) return t("language.current", { locale: getLocale() });
  const locale = parseLocale(params.target);
  if (!locale) return t("language.usage");
  try {
    writeJsonFileAtomic(params.settingsFile, { locale });
  } catch (error) {
    return t("language.saveFailed", { error: error instanceof Error ? error.message : String(error) });
  }
  setLocale(locale);
  process.env.CLI_BRIDGE_LANG = locale;
  const results = await Promise.allSettled(
    (params.adapters ?? []).map((adapter) => adapter.updateLocale?.(locale) ?? true),
  );
  const needsRestart = results.some((result) => result.status === "rejected" || result.value === false);
  return t("language.changed", { locale }) + (needsRestart ? `\n${t("language.companionRestart")}` : "");
}
