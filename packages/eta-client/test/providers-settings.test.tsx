// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../src/app/theme.tsx";
import { SettingsDialog } from "../src/features/settings/settings-dialog.tsx";
import { SettingsPage } from "../src/pages/settings-page.tsx";
import { render, click, setField, fireEvent } from "./render.tsx";
import { byId } from "./dom.ts";

const kimi = { id: "kimi-for-coding", contextWindow: 262144, reasoning: true, thinkingMode: "both", reasoningEfforts: ["low", "high", "max"], providerDefaultEffort: "high" };
let catalog: any;
let discoveryFails = false;
let deleteFails = false;
const deletions: { url: string; revision: string }[] = [];
const writes: any[] = [];

beforeEach(() => {
	writes.length = 0;
	discoveryFails = false;
	deleteFails = false; deletions.length = 0;
	catalog = { revision: "one", providers: [] };
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		const data = init?.body ? JSON.parse(String(init.body)) : undefined;
		if (init?.method === "DELETE") {
			deletions.push({ url, revision: data.revision });
			if (deleteFails) return Response.json({ error: "provider_in_use" }, { status: 409 });
			catalog = { revision: "deleted", providers: [] };
			return Response.json(catalog);
		}
		if (url === "/api/providers/discover") return Response.json(discoveryFails ? { error: "authentication_failed" } : { models: [{ ...kimi, id: data?.provider?.kind === "deepseek" ? "deepseek-flash" : kimi.id }] }, { status: discoveryFails ? 502 : 200 });
		if (url === "/api/providers" && data) {
			writes.push(data);
			const { apiKey, ...provider } = data.provider;
			catalog = { revision: "two", providers: [{ ...provider, hasApiKey: Boolean(apiKey) }] };
			return Response.json(catalog);
		}
		return Response.json(url === "/api/providers" ? catalog : url === "/api/personas" ? [] : {});
	}));
});

function mount() { return render(<ThemeProvider><SettingsPage /></ThemeProvider>); }
const i18nSuppressed = /not sent|不发送/;
async function openKimi() {
	click("settings-tab-providers");
	await vi.waitFor(() => expect(byId("provider-add-kimi")).toBeTruthy());
	click("provider-add-kimi");
}

describe("provider settings", () => {
	it("uses ChatGPT login for Codex without an API key or local token import", async () => {
		const page = mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-add-openai-codex")).toBeTruthy());
		click("provider-add-openai-codex");
		expect(page.queryByTestId("provider-key")).toBeNull();
		expect(page.queryByTestId("codex-use-local")).toBeNull();
		const original = vi.mocked(fetch).getMockImplementation()!;
		vi.mocked(fetch).mockImplementation(async (url, init) => {
			if (url === "/api/providers/codex/login") { expect(JSON.parse(String(init?.body)).method).toBe("browser"); return Response.json({ id: "login-attempt", status: "pending" }); }
			if (url === "/api/providers/codex/status") return Response.json({ id: "login-attempt", status: "complete" });
			if (url === "/api/providers/discover") return Response.json({ models: [{ ...kimi, id: "codex-test-model" }] });
			return original(url, init);
		});
		click("codex-login");
		await vi.waitFor(() => expect(page.queryByText("codex-test-model")).toBeTruthy());
		click("provider-save");
		await vi.waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].provider).toMatchObject({ id: "openai-codex", kind: "openai-codex" });
		expect(writes[0].provider.apiKey).toBeUndefined();
	});

	it("offers browser authorization and submits the manual callback only when requested", async () => {
		const page = mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-add-openai-codex")).toBeTruthy());
		click("provider-add-openai-codex");
		const original = vi.mocked(fetch).getMockImplementation()!;
		const pending = { id: "browser-attempt", status: "pending", method: "browser", url: "https://auth.openai.com/oauth/authorize?state=test", manualPromptId: "prompt" };
		const answers: unknown[] = [];
		vi.mocked(fetch).mockImplementation(async (url, init) => {
			if (url === "/api/providers/codex/login" || url === "/api/providers/codex/status") return Response.json(pending);
			if (url === "/api/providers/codex/answer") { answers.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
			return original(url, init);
		});
		click("codex-login");
		await vi.waitFor(() => expect(page.getByRole("link", { name: /打开 ChatGPT 登录页面|Open ChatGPT sign-in/ })).toBeTruthy());
		expect(page.queryByText(/需在 ChatGPT 安全设置中启用设备代码登录/)).toBeNull();
		fireEvent.click(page.getByText(/授权后没有自动返回|Authorization did not return automatically/));
		setField("codex-login-answer", "http://localhost:1455/auth/callback?code=test&state=test");
		expect(answers).toEqual([]);
		fireEvent.click(page.getByRole("button", { name: /^(继续|Continue)$/ }));
		await vi.waitFor(() => expect(answers).toEqual([{ id: "browser-attempt", promptId: "prompt", value: "http://localhost:1455/auth/callback?code=test&state=test" }]));
		await vi.waitFor(() => expect((byId("codex-login-answer") as HTMLInputElement).value).toBe(""));
	});

	it("explains that the backend needs a restart when its login route is missing", async () => {
		mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-add-openai-codex")).toBeTruthy());
		click("provider-add-openai-codex");
		const original = vi.mocked(fetch).getMockImplementation()!;
		vi.mocked(fetch).mockImplementation(async (url, init) => url === "/api/providers/codex/login"
			? Response.json({ error: "not_found" }, { status: 404 }) : original(url, init));
		click("codex-login");
		await vi.waitFor(() => expect(byId("provider-error").textContent).toMatch(/重启 Eta 后端|Restart the Eta backend/));
		expect(byId("provider-error").textContent).not.toMatch(/超时|expired/);
	});

	it("merges general and appearance, and keeps model configuration in providers", async () => {
		const page = mount();
		expect(page.getAllByRole("button", { name: /General|通用/ })).toHaveLength(1);
		expect(byId("theme-dark")).toBeTruthy();
		expect(page.queryByTestId("default-thinking")).toBeNull();
		await openKimi();
		expect(page.container.querySelector("img.provider-kimi-logo")).toBeTruthy();
	});

	it("discovers models, displays only provider efforts, and saves a real provider payload", async () => {
		const page = mount();
		await openKimi();
		setField("provider-key", "key-for-test");
		click("provider-discover");
		await vi.waitFor(() => expect(page.getByRole("combobox", { name: /kimi-for-coding/ })).toBeTruthy());
		const effort = page.getByRole("combobox", { name: /kimi-for-coding/ }) as HTMLSelectElement;
		expect([...effort.options].map(option => option.value)).toEqual(["", "off", "low", "high", "max"]);
		fireEvent.change(effort, { target: { value: "max" } });
		click("provider-save");
		await vi.waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].provider).toMatchObject({ kind: "kimi-coding", apiKey: "key-for-test", models: [{ id: "kimi-for-coding", defaultThinking: "max" }] });
		await vi.waitFor(() => expect((byId("provider-key") as HTMLInputElement).value).toBe(""));
	});

	it("connects the DeepSeek preset and offers its canonical effort levels", async () => {
		const page = mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-add-deepseek")).toBeTruthy());
		click("provider-add-deepseek");
		setField("provider-key", "deepseek-test-key");
		click("provider-discover");
		await vi.waitFor(() => expect(page.getByRole("combobox", { name: /deepseek-flash/ })).toBeTruthy());
		const effort = page.getByRole("combobox", { name: /deepseek-flash/ }) as HTMLSelectElement;
		expect([...effort.options].map(option => option.value)).toEqual(["", "off", "low", "high", "max"]);
		fireEvent.change(effort, { target: { value: "max" } });
		click("provider-save");
		await vi.waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].provider).toMatchObject({ kind: "deepseek", baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-flash", defaultThinking: "max" }] });
	});

	it("keeps existing models and the draft when discovery fails", async () => {
		catalog = { revision: "one", providers: [{ id: "kimi-coding", kind: "kimi-coding", baseUrl: "https://api.kimi.com/coding/v1", hasApiKey: true, models: [kimi] }] };
		const page = mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-kimi-coding")).toBeTruthy());
		click("provider-kimi-coding");
		discoveryFails = true;
		setField("provider-key", "bad-key");
		click("provider-discover");
		await vi.waitFor(() => expect(page.getByRole("alert").textContent).toMatch(/API Key|API key/));
		expect(page.getByRole("combobox", { name: /kimi-for-coding/ })).toBeTruthy();
		expect((byId("provider-key") as HTMLInputElement).value).toBe("bad-key");
		expect(writes).toHaveLength(0);
	});

	it("supports custom providers without a discovery API", async () => {
		mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-add-custom")).toBeTruthy());
		click("provider-add-custom");
		setField("provider-name", "Local inference");
		setField("provider-url", "http://localhost:8080/v1");
		click("provider-add-model");
		setField("custom-model-id", "local-model");
		expect(byId("custom-model-id").closest("details")?.open).toBe(true);
		click("provider-save");
		await vi.waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].provider).toMatchObject({ kind: "openai-compatible", models: [{ id: "local-model" }] });
	});

	it("keeps delete confirmation in the visible action area and supports cancellation", async () => {
		catalog = { revision: "one", providers: [{ id: "kimi-coding", kind: "kimi-coding", baseUrl: "https://api.kimi.com/coding/v1", hasApiKey: true, models: [kimi] }] };
		mount(); click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-kimi-coding")).toBeTruthy());
		click("provider-kimi-coding"); click("provider-delete");
		expect(byId("provider-delete-confirm").closest(".settings-provider-actions")).not.toBeNull();
		await vi.waitFor(() => expect(document.activeElement).toBe(byId("provider-delete-cancel")));
		expect(deletions).toHaveLength(0);
		click("provider-delete-cancel");
		expect(byId("provider-delete")).toBeTruthy();
		expect(deletions).toHaveLength(0);
	});

	it("deletes a provider only after confirmation and returns to the updated list", async () => {
		catalog = { revision: "one", providers: [{ id: "kimi-coding", kind: "kimi-coding", baseUrl: "https://api.kimi.com/coding/v1", hasApiKey: true, models: [kimi] }] };
		const page = mount(); click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-kimi-coding")).toBeTruthy());
		click("provider-kimi-coding"); click("provider-delete"); click("provider-delete-submit");
		await vi.waitFor(() => expect(byId("provider-add-kimi")).toBeTruthy());
		expect(deletions).toEqual([{ url: "/api/providers/kimi-coding", revision: "one" }]);
		expect(page.queryByTestId("provider-kimi-coding")).toBeNull();
	});

	it("keeps a refused deletion and its reason in the action area", async () => {
		catalog = { revision: "one", providers: [{ id: "kimi-coding", kind: "kimi-coding", baseUrl: "https://api.kimi.com/coding/v1", hasApiKey: true, models: [kimi] }] };
		deleteFails = true;
		mount(); click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-kimi-coding")).toBeTruthy());
		click("provider-kimi-coding"); click("provider-delete"); click("provider-delete-submit");
		await vi.waitFor(() => expect(byId("provider-error").textContent).toMatch(/still using|仍在使用/));
		expect(byId("provider-error").closest(".settings-provider-actions")).not.toBeNull();
		expect(byId("provider-delete-submit").hasAttribute("disabled")).toBe(false);
		expect(catalog.providers).toHaveLength(1);
	});

	it("edits custom request headers as rows and round-trips them through the saved provider", async () => {
		catalog = {
			revision: "one",
			providers: [{ id: "kimi-coding", kind: "kimi-coding", baseUrl: "https://api.kimi.com/coding/v1", hasApiKey: true, headers: { "User-Agent": "eta/0.9" }, models: [kimi] }],
		};
		mount();
		click("settings-tab-providers");
		await vi.waitFor(() => expect(byId("provider-kimi-coding")).toBeTruthy());
		click("provider-kimi-coding");
		expect((byId("provider-header-name-0") as HTMLInputElement).value).toBe("User-Agent");
		setField("provider-header-value-0", "eta-agent/1");
		click("provider-add-header");
		setField("provider-header-name-1", "X-Title");
		// An empty value is a decision, not a blank: the row says so.
		expect(byId("provider-header-suppressed-1").textContent).toMatch(i18nSuppressed);
		const idle = byId("provider-save").textContent!;
		click("provider-save");
		await vi.waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0].provider.headers).toEqual({ "User-Agent": "eta-agent/1", "X-Title": null });
		// The editor is re-seeded from the saved provider once the save settles, so the second
		// write proves both the echo and that a suppressed header stays a row with an empty value.
		await vi.waitFor(() => expect(byId("provider-save").textContent).toBe(idle));
		click("provider-header-remove-0");
		click("provider-save");
		await vi.waitFor(() => expect(writes).toHaveLength(2));
		expect(writes[1].provider.headers).toEqual({ "X-Title": null });
	});

	it("keeps the modal open for unsaved changes and closes cleanly after discarding", async () => {
		const close = vi.fn();
		HTMLDialogElement.prototype.showModal = function () { this.open = true; };
		HTMLDialogElement.prototype.close = function () { this.open = false; };
		const page = render(<ThemeProvider><SettingsDialog onClose={close} /></ThemeProvider>, { baseElement: document.body });
		await openKimi();
		setField("provider-key", "unsaved-key");
		click("settings-close");
		expect(close).not.toHaveBeenCalled();
		expect(byId("settings-discard").textContent).toMatch(/not been saved|尚未保存/);
		click("settings-discard-confirm");
		expect(close).toHaveBeenCalledTimes(1);
		expect(page.queryByText(/ESC/)).toBeNull();
	});
});
