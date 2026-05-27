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
