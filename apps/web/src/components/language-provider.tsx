import type { ReactNode } from "react";
import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import {
  applyDocumentLanguage,
  i18n,
  readLanguagePreference,
  resolveLanguage,
  subscribeLanguagePreference,
} from "@/lib/i18n";

export function LanguageProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const syncLanguage = () => {
      const language = resolveLanguage(readLanguagePreference());
      if (language !== i18n.resolvedLanguage)
        void i18n.changeLanguage(language);
      applyDocumentLanguage();
    };
    syncLanguage();
    const unsubscribe = subscribeLanguagePreference(syncLanguage);
    i18n.on("languageChanged", applyDocumentLanguage);
    window.addEventListener("languagechange", syncLanguage);
    return () => {
      i18n.off("languageChanged", applyDocumentLanguage);
      window.removeEventListener("languagechange", syncLanguage);
      unsubscribe();
    };
  }, []);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
