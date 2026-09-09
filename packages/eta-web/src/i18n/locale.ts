export const localeStorageKey = "eta.locale";
export const localeCookieKey = "eta.locale";
export const localeChangeEvent = "eta:locale-change";
export const supported = ["en", "zh-CN"] as const;

export type StoredLocale = (typeof supported)[number];

export function normalizeLocale(raw: string | undefined | null): StoredLocale | undefined {
	if (raw === undefined || raw === null) return undefined;
	const value = raw.trim();
	if (value === "") return undefined;
	if (value.startsWith("zh")) return "zh-CN";
	if (value.startsWith("en")) return "en";
	return (supported as readonly string[]).includes(value) ? (value as StoredLocale) : undefined;
}

export function detectLocale(search: string, storage: string | null, cookie: string | null, navigatorLang: string | undefined): StoredLocale {
	const params = new URLSearchParams(search);
	const fromUrl = normalizeLocale(params.get("locale") ?? params.get("lang"));
	if (fromUrl !== undefined) return fromUrl;
	const fromStorage = normalizeLocale(storage);
	if (fromStorage !== undefined) return fromStorage;
	const fromCookie = normalizeLocale(readCookie(cookie));
	if (fromCookie !== undefined) return fromCookie;
	const fromNavigator = normalizeLocale(navigatorLang);
	if (fromNavigator !== undefined) return fromNavigator;
	return "zh-CN";
}

function readCookie(cookie: string | null): string | undefined {
	if (cookie === null) return undefined;
	for (const part of cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === localeCookieKey) return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

export function persistLocale(next: StoredLocale): void {
	try {
		localStorage.setItem(localeStorageKey, next);
		document.cookie = `${localeCookieKey}=${encodeURIComponent(next)}; path=/; samesite=lax`;
	} catch {
		/* private mode */
	}
	document.documentElement.lang = next;
	window.dispatchEvent(new CustomEvent(localeChangeEvent));
}
