// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId } from "./dom.ts";
import { render, setField, click } from "./render.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";
import { SettingsPage } from "../src/pages/settings-page.tsx";
import "../src/i18n.ts";

interface Posted {
	url: string;
	body: Record<string, unknown>;
}

const served: Record<string, unknown> = {};
const posted: Posted[] = [];

function stubFetch(): void {
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
			return Promise.resolve({ ok: true, json: () => Promise.resolve({ personaId: "reviewer" }) } as Response);
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve(served[url] ?? null) } as Response);
	});
}

/** Let the page's promise chains settle without a timer. */
async function until(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			assertion();
			return;
		} catch {
			await Promise.resolve();
		}
	}
	assertion();
}

describe("settings page", () => {
	beforeEach(() => {
		posted.length = 0;
		served["/api/settings"] = { personaId: "reviewer", thinkingLevel: "low", keepRecentTokens: 12_000 };
		served["/api/personas"] = [
			{ id: "reviewer", name: "Reviewer" },
			{ id: "coach", name: "Coach" },
		];
		served["/api/providers"] = { revision: "1", providers: [] };
		served["/api/models"] = { models: [{ id: "pro6000:kimi", label: "kimi" }], current: "pro6000:kimi" };
		stubFetch();
	});

	it("shows the stored defaults and posts the change that touches them", async () => {
		render(
			<ThemeProvider>
				<SettingsPage />
			</ThemeProvider>,
		);
		click("settings-tab-session");
		await until(() => {
			expect((byId("default-persona") as HTMLSelectElement).value).toBe("reviewer");
			expect((byId("default-keep-recent") as HTMLInputElement).value).toBe("12000");
		});
		setField("default-persona", "coach");
		await until(() => {
			expect(posted.at(-1)).toEqual({ url: "/api/settings", body: { personaId: "coach" } });
		});
		await until(() => {
			expect(byId("settings-save-state").textContent).toContain("saved");
		});
	});

	it("clearing an option sends null so the host drops the key", async () => {
		render(
			<ThemeProvider>
				<SettingsPage />
			</ThemeProvider>,
		);
		click("settings-tab-session");
		await until(() => expect((byId("default-persona") as HTMLSelectElement).value).toBe("reviewer"));
		setField("default-persona", "");
		await until(() => {
			expect(posted.at(-1)).toEqual({ url: "/api/settings", body: { personaId: null } });
		});
	});
});
