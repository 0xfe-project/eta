import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const themeStorageKey = "eta.theme";
export const themeChangeEvent = "eta:theme-change";
export const defaultTheme: ThemePreference = "dark";

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
	return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

function systemPrefersDark(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function storedPreference(): ThemePreference {
	try {
		const value = localStorage.getItem(themeStorageKey);
		if (value === "dark" || value === "light" || value === "system") return value;
	} catch {
		/* private mode */
	}
	return defaultTheme;
}

function applyTheme(theme: ResolvedTheme): void {
	const root = document.documentElement;
	root.classList.toggle("dark", theme === "dark");
	root.classList.toggle("light", theme === "light");
	root.setAttribute("data-theme", theme === "dark" ? "night" : "clean");
	root.style.colorScheme = theme;
}

interface ThemeContextValue {
	theme: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setTheme: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<ThemePreference>(() => storedPreference());
	const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		applyTheme(resolveTheme(theme, systemDark));
	}, [theme, systemDark]);

	useEffect(() => {
		const onStorage = () => setThemeState(storedPreference());
		const onCustom = () => setThemeState(storedPreference());
		window.addEventListener("storage", onStorage);
		window.addEventListener(themeChangeEvent, onCustom);
		return () => {
			window.removeEventListener("storage", onStorage);
			window.removeEventListener(themeChangeEvent, onCustom);
		};
	}, []);

	const setTheme = useCallback((next: ThemePreference) => {
		try {
			localStorage.setItem(themeStorageKey, next);
		} catch {
			/* private mode */
		}
		setThemeState(next);
		window.dispatchEvent(new CustomEvent(themeChangeEvent));
	}, []);

	const value = useMemo<ThemeContextValue>(
		() => ({ theme, resolvedTheme: resolveTheme(theme, systemDark), setTheme }),
		[theme, systemDark, setTheme],
	);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
	const value = useContext(ThemeContext);
	if (value === undefined) throw new Error("useAppTheme outside ThemeProvider");
	return value;
}
