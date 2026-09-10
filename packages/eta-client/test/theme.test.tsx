// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { click, render } from "./render.tsx";
import { ThemeProvider, resolveTheme } from "../src/app/theme.tsx";
import "../src/i18n.ts";

describe("theme provider", () => {
	it("resolveTheme maps preferences against the system", () => {
		expect(resolveTheme("dark", true)).toBe("dark");
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
	});

	it("toggling writes the dark class, color-scheme and localStorage", async () => {
		const { SettingsPage } = await import("../src/pages/settings-page.tsx");
		render(
			<ThemeProvider>
				<SettingsPage />
			</ThemeProvider>,
		);
		click("theme-light");
		expect(document.documentElement.classList.contains("light")).toBe(true);
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(localStorage.getItem("eta.theme")).toBe("light");
		click("theme-dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem("eta.theme")).toBe("dark");
	});
});
