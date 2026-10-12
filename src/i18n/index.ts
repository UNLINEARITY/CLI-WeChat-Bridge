// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import { messages as zhMessages } from "./messages-zh.ts";
import { messages as enMessages } from "./messages-en.ts";

export type Locale = "zh" | "en";

const catalogs: Record<Locale, Record<string, string>> = {
  zh: zhMessages,
  en: enMessages,
};

let currentLocale: Locale = "zh";

export function getLocale(): Locale {
  return currentLocale;
}

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["en", "english", "英文"].includes(normalized)) return "en";
  if (["zh", "chinese", "中文"].includes(normalized)) return "zh";
  return null;
}

export function readLocalePreference(filePath: string): Locale | null {
  try {
    return parseLocale(JSON.parse(fs.readFileSync(filePath, "utf8"))?.locale);
  } catch {
    return null;
  }
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function initLocaleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback: Locale = "zh",
): void {
  currentLocale = parseLocale(env.CLI_BRIDGE_LANG) ?? fallback;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const catalog = catalogs[currentLocale];
  let message = catalog[key] ?? catalogs.en[key] ?? key;

  if (params) {
    message = message.replace(/\{(\w+)\}/g, (token, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : token,
    );
  }

  return message;
}
