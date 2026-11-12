import type { Locale } from "../config/types";
import type { Localized, MessageCatalog } from "../extensions/types";

export type MessageParams = Record<string, string | number>;

/** Looks a key up in the current language and fills its `{name}` placeholders. */
export type Translate<K extends string> = (
  key: K,
  params?: MessageParams,
) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Declares a feature's texts. The Chinese side must have exactly the English keys: a missing or
 * extra key fails the type check. Export the result, so the parity test finds it.
 */
export function defineMessages<const K extends string>(catalog: {
  en: Record<K, string>;
  zh: NoInfer<Record<K, string>>;
}): MessageCatalog<K> {
  return catalog;
}

/** Substitutes `{name}` with `params.name`; a placeholder without a value stays as written. */
export function fillPlaceholders(
  template: string,
  params?: MessageParams,
): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params?.[name];
    return value === undefined ? whole : String(value);
  });
}

/** The placeholder names in a text, each once, sorted. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""))]
    .filter((name) => name !== "")
    .sort();
}

export function translatorFor<K extends string>(
  catalog: MessageCatalog<K>,
  locale: Locale,
): Translate<K> {
  const texts = catalog[locale];
  return (key, params) => fillPlaceholders(texts[key], params);
}

export function localize(text: Localized, locale: Locale): string {
  return text[locale];
}
