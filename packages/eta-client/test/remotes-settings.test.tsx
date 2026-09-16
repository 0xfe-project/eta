// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId, queryId } from "./dom.ts";
import { click, render, setField } from "./render.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";
import { SettingsPage } from "../src/pages/settings-page.tsx";
import "../src/i18n.ts";

const posted: { url: string; method?: string; body?: unknown }[] = [];
let remotes: unknown[] = [];

function stubFetch(): void {
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/remotes/discover")) return Promise.resolve({ ok: true, json: () => Promise.resolve(["devbox"]) } as Response);

		if (url.includes("/api/remotes") && init?.method && init.method !== "GET") {
			posted.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
			if (url.endsWith("/api/remotes") && init.method === "POST") {
				const body = JSON.parse(String(init.body)) as { name: string; host: string };
				remotes = [{ id: "r1", name: body.name, host: body.host, autoConnect: false, projects: [], forwards: [], status: "disconnected", logs: [], ports: [] }];
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve(remotes) } as Response);
		}
		if (url.endsWith("/api/remotes")) return Promise.resolve({ ok: true, json: () => Promise.resolve(remotes) } as Response);
		if (url.includes("/api/settings")) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
		if (url.includes("/api/personas")) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response);
		if (url.includes("/api/providers")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ revision: "1", providers: [] }) } as Response);
		return Promise.resolve({ ok: true, json: () => Promise.resolve(null) } as Response);
	});
}

async function until(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			assertion();
			return;
		} catch {
			await Promise.resolve();
		}
	}
	assertion();
}

describe("remote settings", () => {
	beforeEach(() => {
		posted.length = 0;
		remotes = [];
		stubFetch();
	});

	it("saves an SSH host from the remotes tab", async () => {
		render(
			<ThemeProvider>
				<SettingsPage />
			</ThemeProvider>,
		);
		click("settings-tab-remotes");
		click("remote-add");
		await until(() => {
			expect(byId("remote-draft").tagName).toBe("DIALOG");
		});
		setField("remote-name", "devbox");
		setField("remote-host", "devbox");
		click("remote-save");
		await until(() => {
			expect(posted.some((item) => item.url.endsWith("/api/remotes") && (item.body as { host: string }).host === "devbox")).toBe(true);
			expect(queryId("remote-row-r1")).not.toBeNull();
			expect(queryId("remote-draft")).toBeNull();
		});
		expect(byId("remote-status-r1")).toBeTruthy();
	});

	it("names the machine and backend whose settings it edits", async () => {
		remotes = [
			{
				id: "r1",
				name: "Mac mini",
				host: "192.168.198.85",
				autoConnect: false,
				projects: [],
				forwards: [],
				status: "connected",
				logs: [],
				ports: [],
				backend: { version: "0.2.0", protocol: 2, pid: 4242, reused: true },
			},
		];
		render(
			<ThemeProvider>
				<SettingsPage />
			</ThemeProvider>,
		);
		click("settings-tab-remotes");
		await until(() => {
			expect(queryId("remote-row-r1")).not.toBeNull();
		});
		click("remote-open-r1");
		await until(() => {
			expect(byId("remote-backend-r1").textContent).toContain("4242");
		});
		expect(byId("remote-backend-r1").textContent).toContain("0.2.0");

	});

	it("closes the add dialog without saving", async () => {
		render(
			<ThemeProvider>
				<SettingsPage />
			</ThemeProvider>,
		);
		click("settings-tab-remotes");
		click("remote-add");
		await until(() => {
			expect(queryId("remote-draft")).not.toBeNull();
		});
		click("remote-cancel");
		await until(() => {
			expect(queryId("remote-draft")).toBeNull();
		});
		expect(posted).toEqual([]);
	});
});
