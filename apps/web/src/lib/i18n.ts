import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { z } from "zod";
import { namespaces, resources } from "@/locales/resources";

export type Language = "en" | "zh";
export type LanguagePreference = Language | "system";
export const languageStorageKey = "eta.language.v1";
const preferenceSchema = z.enum(["en", "zh", "system"]);
const preferenceEvent = "eta:language-preference";
let volatilePreference: LanguagePreference | undefined;

// Inline resources initialize synchronously. The shared instance starts in
// English; main.tsx applies the browser preference before the first paint.
export function createI18n(language: Language = "en") {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: "en",
    supportedLngs: ["en", "zh"],
    ns: [...namespaces],
    defaultNS: "common",
    resources: structuredClone(resources),
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}

export const i18n = createI18n();

/** Utilities and event handlers translate at call time, never at module load. */
export const translate = i18n.getFixedT(null, namespaces);

export function detectLanguage(languages: readonly string[]): Language {
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh" || base === "en") return base;
  }
  return "en";
}

export function readLanguagePreference(): LanguagePreference {
  if (volatilePreference) return volatilePreference;
  try {
    const saved = localStorage.getItem(languageStorageKey);
    const result = preferenceSchema.safeParse(saved ? JSON.parse(saved) : null);
    return result.success ? result.data : "system";
  } catch {
    return "system";
  }
}

export function resolveLanguage(preference: LanguagePreference): Language {
  return preference === "system"
    ? detectLanguage(
        navigator.languages?.length
          ? navigator.languages
          : [navigator.language],
      )
    : preference;
}

export function setLanguagePreference(preference: LanguagePreference) {
  try {
    localStorage.setItem(languageStorageKey, JSON.stringify(preference));
    volatilePreference = undefined;
  } catch {
    // The current page can still switch when browser storage is unavailable.
    volatilePreference = preference;
  }
  void i18n.changeLanguage(resolveLanguage(preference));
  window.dispatchEvent(new Event(preferenceEvent));
}

export function subscribeLanguagePreference(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === languageStorageKey || event.key === null) {
      volatilePreference = undefined;
      onChange();
    }
  };
  window.addEventListener(preferenceEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(preferenceEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function applyDocumentLanguage() {
  document.documentElement.lang =
    i18n.resolvedLanguage === "zh" ? "zh-CN" : "en";
}

export function formatLocale(): string {
  return i18n.resolvedLanguage === "zh" ? "zh-CN" : "en-US";
}

export function listSeparator(): string {
  return i18n.resolvedLanguage === "zh" ? "、" : ", ";
}
