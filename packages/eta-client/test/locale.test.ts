import { describe, expect, it } from "vitest";
import { detectLocale, normalizeLocale } from "../src/i18n/locale.ts";

describe("locale detection", () => {
	it("normalizes dialects onto supported locales", () => {
		expect(normalizeLocale("zh-TW")).toBe("zh-CN");
		expect(normalizeLocale("en-US")).toBe("en");
		expect(normalizeLocale("fr")).toBeUndefined();
	});

	it("prefers url over storage over cookie over navigator", () => {
		expect(detectLocale("?locale=en", "zh-CN", "eta.locale=en", "zh-CN")).toBe("en");
		expect(detectLocale("", "en", "eta.locale=zh-CN", "zh-CN")).toBe("en");
		expect(detectLocale("", null, "eta.locale=en; other=1", "zh-CN")).toBe("en");
		expect(detectLocale("", null, null, "en-GB")).toBe("en");
		expect(detectLocale("", null, null, undefined)).toBe("zh-CN");
	});
});
