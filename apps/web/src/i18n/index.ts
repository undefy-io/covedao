import { en, type MessageKey } from "./en";
import { zhCN } from "./zh-CN";

/**
 * Languages the app speaks. English is the default; Chinese is mainland
 * Simplified Chinese (see GLOSSARY.md for the house terms).
 */
export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];
export type { MessageKey };

/** Cookie (read by the server layout) and localStorage key for the choice. */
export const LANG_COOKIE = "covs_lang";

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, zh: zhCN };

/** "zh", "zh-CN", "zh-Hans", "cn" → zh; anything else → en. */
export function parseLang(raw: string | null | undefined): Lang {
  const v = (raw ?? "").toLowerCase();
  return v === "zh" || v.startsWith("zh-") || v === "cn" ? "zh" : "en";
}

export type Vars = Record<string, string | number | bigint>;

/** Fill `{name}` placeholders. */
function fill(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translate `key` into `lang`. Never throws: a missing entry falls back to English. */
export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  return fill(DICTS[lang][key] ?? en[key], vars);
}

/** True when `key` is a message key (used for server error codes). */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/**
 * The language in effect, for code outside React (error helpers, formatters).
 * The LanguageProvider keeps it in step with the UI.
 */
let current: Lang = "en";
export function setCurrentLang(lang: Lang): void {
  current = lang;
}
export function currentLang(): Lang {
  return current;
}

/** Translate with the current language (outside React). */
export function tr(key: MessageKey, vars?: Vars): string {
  return translate(current, key, vars);
}

/**
 * A server error in the reader's language: known error codes have their own
 * message; anything else keeps the server's own words.
 */
export function translateError(code: string | undefined, fallback: string): string {
  if (current === "en" || !code) return fallback;
  const key = `err.${code}`;
  return isMessageKey(key) ? translate(current, key) : fallback;
}

/** BCP 47 tag for Intl and <html lang>. */
export function htmlLang(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en";
}
