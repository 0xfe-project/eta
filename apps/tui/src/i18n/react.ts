import type { Locale } from "../config/types";
import type { MessageCatalog } from "../extensions/types";
import type { Translate } from "./messages";
import { createContext, use, useMemo } from "react";
import { translatorFor } from "./messages";

/** Provided by the App: the interface language in effect. */
export const LocaleContext = createContext<Locale>("en");

/** The interface language in effect; it changes when `/config` reloads a new `locale`. */
export function useLocale(): Locale {
  return use(LocaleContext);
}

/** The translate function of a catalog in the current language. */
export function useMessages<K extends string>(
  catalog: MessageCatalog<K>,
): Translate<K> {
  const locale = useLocale();
  return useMemo(() => translatorFor(catalog, locale), [catalog, locale]);
}
