// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId, queryId } from "./dom.ts";
import { click, render, setField } from "./render.tsx";
import { ThemeProvider } from "../src/app/theme.tsx";
import { SettingsPage } from "../src/pages/settings-page.tsx";
import "../src/i18n.ts";

const posted: { url: string; method?: string; body?: unknown }[] = [];
let remotes: unknown[] = [];
let hostFailure: string | undefined;
let trustFailure = false;

function stubFetch(): void {
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/remotes/discover")) return Promise.resolve({ ok: true, json: () => Promise.resolve(["devbox"]) } as Response);

		if (url.includes("/api/remotes") && init?.method && init.method !== "GET") {
			posted.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
			if (url.endsWith("/host-key")) return Promise.resolve(Response.json({ challengeId: "challenge", host: "devbox", algorithm: "ED25519", fingerprint: "SHA256:testFingerprint", prompt: "OpenSSH host prompt" }));
			if (url.endsWith("/trust-host")) {
				if (trustFailure) return Promise.resolve(Response.json({ error: "Host key changed" }, { status: 400 }));
				hostFailure = undefined;
			}
			if (hostFailure && /\/(connect|test|install)$/.test(url)) return Promise.resolve(Response.json({ error: "Host key verification failed", kind: hostFailure }, { status: 400 }));
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
		hostFailure = undefined;
		trustFailure = false;
		posted.length = 0;
		remotes = [];
		stubFetch();
	});

	async function showHost() {
		remotes = [{ id: "r1", name: "devbox", host: "devbox", status: "disconnected", projects: [], forwards: [], logs: [], ports: [] }];
		hostFailure = "host-key";
		render(<ThemeProvider><SettingsPage /></ThemeProvider>);
		click("settings-tab-remotes");
		await until(() => expect(queryId("remote-row-r1")).not.toBeNull());
	}

	it.each(["connect", "test", "install"])("asks before trusting and resumes %s only after confirmation", async (action) => {
		await showHost();
		if (action === "install") {
			click("remote-open-r1");
			click("remote-install-r1");
			click("remote-install-yes");
		} else click(`remote-${action}-r1`);
		await until(() => {
			expect(queryId("remote-host-key")).not.toBeNull();
			expect((byId("remote-host-trust") as HTMLButtonElement).disabled).toBe(false);
		});
		expect(byId("remote-host-key").tagName).toBe("DIALOG");
		expect(byId("remote-host-fingerprint").textContent).toBe("SHA256:testFingerprint");
		expect(posted.some(item => item.url.endsWith("/trust-host"))).toBe(false);
		click("remote-host-trust");
		await until(() => expect(posted.filter(item => item.url.endsWith(`/${action}`))).toHaveLength(2));
		expect(posted.find(item => item.url.endsWith("/trust-host"))?.body).toEqual({ challengeId: "challenge" });
		expect(queryId("remote-host-key")).toBeNull();
	});

	it("cancel does not trust or retry, and a changed key cannot be accepted", async () => {
		await showHost();
		click("remote-connect-r1");
		await until(() => {
			expect(queryId("remote-host-key")).not.toBeNull();
			expect((byId("remote-host-trust") as HTMLButtonElement).disabled).toBe(false);
		});
		click("remote-host-cancel");
		expect(queryId("remote-host-key")).toBeNull();
		expect(posted.some(item => item.url.endsWith("/trust-host"))).toBe(false);
		hostFailure = "host-key-changed";
		click("remote-connect-r1");
		await until(() => expect(byId("remotes-error").textContent).toMatch(/密钥|host key/));
		expect(queryId("remote-host-key")).toBeNull();
	});

	it("keeps the dialog open if the key changes during confirmation", async () => {
		await showHost();
		click("remote-connect-r1");
		await until(() => {
			expect(queryId("remote-host-key")).not.toBeNull();
			expect((byId("remote-host-trust") as HTMLButtonElement).disabled).toBe(false);
		});
		trustFailure = true;
		click("remote-host-trust");
		await until(() => expect(byId("remote-host-key").textContent).toContain("Host key changed"));
		expect(posted.filter(item => item.url.endsWith("/connect"))).toHaveLength(1);
		click("remote-host-cancel");
	});

	it("shows first-contact auto-connect as pending, not a red error", async () => {
		remotes = [{ id: "r1", name: "devbox", host: "devbox", status: "awaiting-trust", error: "Host key verification failed", projects: [], forwards: [], logs: [], ports: [] }];
		render(<ThemeProvider><SettingsPage /></ThemeProvider>);
		click("settings-tab-remotes");
		await until(() => expect(queryId("remote-trust-pending-r1")).not.toBeNull());
		expect(byId("remote-row-r1").textContent).not.toContain("Host key verification failed");
		expect(queryId("remotes-error")).toBeNull();
		expect(queryId("remote-host-key")).toBeNull();
		expect((byId("remote-connect-r1") as HTMLButtonElement).disabled).toBe(false);
		expect((byId("remote-test-r1") as HTMLButtonElement).disabled).toBe(false);
		expect((byId("remote-edit-r1") as HTMLButtonElement).disabled).toBe(false);
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
