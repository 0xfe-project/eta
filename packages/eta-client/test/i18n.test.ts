import { describe, expect, it } from "vitest";
import en from "../../eta-i18n/src/locales/en.json";
import zhCN from "../../eta-i18n/src/locales/zh-CN.json";

function keySet(obj: Record<string, unknown>, prefix = ""): string[] {
	return Object.entries(obj).flatMap(([key, value]) =>
		typeof value === "object" && value !== null
			? keySet(value as Record<string, unknown>, `${prefix}${key}.`)
			: [`${prefix}${key}`],
	);
}

describe("i18n resources", () => {
	it("en and zh-CN carry exactly the same keys", () => {
		expect(keySet(en).sort()).toEqual(keySet(zhCN).sort());
	});
});
