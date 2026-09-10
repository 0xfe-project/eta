import i18next, { type i18n as I18nInstance } from "i18next";
import { createSignal } from "solid-js";
import { defaultLocale, resources, supportedLocales, type AppLocale, type TranslationKey } from "@eta/i18n";
import { detectLocale, localeChangeEvent, localeStorageKey, persistLocale } from "./i18n/locale.ts";

export const i18n: I18nInstance = i18next.createInstance();

const initialLocale =
	typeof window === "undefined"
		? defaultLocale
		: detectLocale(
				window.location.search,
				(() => {
					try {
						return localStorage.getItem(localeStorageKey);
					} catch {
						return null;
					}
				})(),
				document.cookie || null,
				navigator.language,
			);

void i18n.init({
	fallbackLng: defaultLocale,
	interpolation: { escapeValue: false, prefix: "{", suffix: "}" },
	keySeparator: false,
	nsSeparator: false,
	lng: initialLocale,
	resources,
	supportedLngs: [...supportedLocales],
});

const [locale, setLocaleState] = createSignal<AppLocale>(initialLocale === "en" ? "en" : "zh-CN");

if (typeof window !== "undefined") {
	document.documentElement.lang = initialLocale;
	const params = new URLSearchParams(window.location.search);
	if (params.has("locale") || params.has("lang")) {
		params.delete("locale");
		params.delete("lang");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query.length > 0 ? `?${query}` : ""}${window.location.hash}`,
		);
	}
	window.addEventListener("storage", () => void applyExternalLocale());
	window.addEventListener(localeChangeEvent, () => void applyExternalLocale());
}

async function applyExternalLocale(): Promise<void> {
	const next = detectLocale(window.location.search, safeStorage(), document.cookie || null, navigator.language);
	if (next !== i18n.language) await i18n.changeLanguage(next);
	document.documentElement.lang = next;
	setLocaleState(next === "en" ? "en" : "zh-CN");
}

function safeStorage(): string | null {
	try {
		return localStorage.getItem(localeStorageKey);
	} catch {
		return null;
	}
}

export function useAppI18n(): {
	locale: AppLocale;
	setLocale: (next: AppLocale) => void;
	t: (key: TranslationKey, options?: Record<string, unknown>) => string;
} {
	return {
		get locale() {
			return locale();
		},
		setLocale: (next) => persistLocale(next),
		t: (key, options) => {
			locale();
			return String(i18n.t(String(key), options));
		},
	};
}
