import type { ReactNode } from "react";
import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n } from "@/lib/i18n";

/** Keeps the stories' language in step with the toolbar's locale. */
export function Locale({
  locale,
  children,
}: {
  locale: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [locale]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
