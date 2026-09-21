// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { messages as zhMessages } from "./messages-zh.ts";
import { messages as enMessages } from "./messages-en.ts";

export type Locale = "zh" | "en";

const catalogs: Record<Locale, Record<string, string>> = {
  zh: zhMessages,
  en: enMessages,
};

let currentLocale: Locale = "zh";

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function initLocaleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const value = env.CLI_BRIDGE_LANG?.trim().toLowerCase();
  if (value === "en" || value === "english") {
    currentLocale = "en";
  } else {
    currentLocale = "zh";
  }
}

export function t(key: string, params?: Record<string, string | number>): string {
  const catalog = catalogs[currentLocale];
  let message = catalog[key] ?? catalogs.en[key] ?? key;

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replaceAll(`{${name}}`, String(value));
    }
  }

  return message;
}
