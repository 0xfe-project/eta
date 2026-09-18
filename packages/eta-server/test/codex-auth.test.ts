import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { CodexCredentialStore, CodexLogin, codexAuthPath, codexCatalog } from "../src/codex-auth.ts";
import { ProviderConfigStore } from "../src/providers.ts";
import { configModels } from "../src/config.ts";

const jwt = (expires: number, account = "test-account") => `test.${Buffer.from(JSON.stringify({ exp: expires, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test`;
async function fixture(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "eta-codex-test-"));
	try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("Codex authentication", () => {

	it("serializes refresh across independent registries and persists private credentials", () => fixture(async directory => {
		const path = join(directory, "auth.json");
		const stores = [new CodexCredentialStore(path), new CodexCredentialStore(path)];
		await stores[0]!.modify("openai-codex", async () => ({ type: "oauth", access: "expired", refresh: "old", expires: 0 }));
		let refreshes = 0;
		const registries = stores.map(credentials => {
			const models = createModels({ credentials });
			models.setProvider(createProvider({ id: "openai-codex", models: [], api: openAICodexResponsesApi(), auth: { oauth: {
				name: "test", login: async () => { throw new Error("unused"); },
				refresh: async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); return { type: "oauth", access: "fresh", refresh: "rotated", expires: Date.now() + 3600_000 }; },
				toAuth: async credential => ({ apiKey: credential.access }),
			} } }));
			return models;
		});
		const resolved = await Promise.all(registries.map(models => models.getAuth("openai-codex")));
		expect(resolved.map(result => result?.auth.apiKey)).toEqual(["fresh", "fresh"]);
		expect(refreshes).toBe(1);
		const saved = await stores[0]!.read("openai-codex");
		expect(saved?.type === "oauth" && saved.refresh).toBe("rotated");
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
	}));

	it("uses the pi Codex transport and never returns credentials in provider views", () => fixture(async directory => {
		const path = join(directory, "config.json");
		const credentials = new CodexCredentialStore(codexAuthPath(path));
		await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 3600_000 }));
		const store = new ProviderConfigStore(path);
		const provider = { id: "openai-codex", name: "My Codex", kind: "openai-codex" as const, baseUrl: "https://chatgpt.com/backend-api", models: [codexCatalog()[0]!] };
		const result = await store.save({ revision: (await store.view()).revision, provider });
		expect(JSON.stringify(result)).not.toContain("private-");
		expect(result.providers[0]?.name).toBe("My Codex");
		const models = configModels({ providers: [provider] }, path)!;
		expect(models.getModels()[0]?.api).toBe("openai-codex-responses");
		expect((await models.getAuth("openai-codex"))?.auth.apiKey).toBe("private-access");
		expect(codexCatalog().map(model => model.id)).toEqual([
			"gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5",
			"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra",
		]);
		expect(codexCatalog().some(model => model.reasoningEfforts?.includes("high"))).toBe(true);
		await store.delete("openai-codex", result.revision);
		expect(await credentials.read("openai-codex")).toBeUndefined();
	}));

	it("defaults to pi browser OAuth and accepts its manual callback fallback", () => fixture(async directory => {
		const originalFetch = globalThis.fetch;
		let exchanges = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected request");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("test-browser-code");
			expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
			expect(body.get("code_verifier")?.length).toBeGreaterThan(20);
			exchanges++;
			return Response.json({ access_token: jwt(Date.now() / 1000 + 3600), refresh_token: "browser-test-refresh", expires_in: 3600 });
		}) as typeof fetch;
		const credentials = new CodexCredentialStore(join(directory, "auth.json"));
		const login = new CodexLogin(credentials);
		try {
			const started = login.start("openai-codex");
			for (let i = 0; i < 100 && !login.status(started.id).manualPromptId; i++) await new Promise(resolve => setTimeout(resolve, 20));
			const view = login.status(started.id);
			expect(view.method).toBe("browser");
			expect(view.userCode).toBeUndefined();
			const url = new URL(view.url!);
			expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
			expect(login.answer("old-attempt", view.manualPromptId!, "stale")).toBe(false);
			const redirect = new URL("http://localhost:1455/auth/callback");
			redirect.searchParams.set("code", "test-browser-code");
			redirect.searchParams.set("state", url.searchParams.get("state")!);
			expect(login.answer(started.id, view.manualPromptId!, redirect.href)).toBe(true);
			for (let i = 0; i < 100 && login.status(started.id).status === "pending"; i++) await new Promise(resolve => setTimeout(resolve, 20));
			expect(login.status(started.id).status).toBe("complete");
			expect(exchanges).toBe(1);
			expect((await credentials.read("openai-codex"))?.type).toBe("oauth");
			login.cancel();
			const cancelled = login.start("openai-codex");
			for (let i = 0; i < 100 && !login.status(cancelled.id).manualPromptId; i++) await new Promise(resolve => setTimeout(resolve, 20));
			const promptId = login.status(cancelled.id).manualPromptId!;
			login.cancel(cancelled.id);
			expect(login.answer(cancelled.id, promptId, "unused")).toBe(false);
			await new Promise(resolve => setTimeout(resolve, 30));
			expect(exchanges).toBe(1);
		} finally { login.cancel(); globalThis.fetch = originalFetch; }
	}));

	it("completes pi device login while exposing only the code and status", () => fixture(async directory => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "test-device", user_code: "ABCD-EFGH", interval: 0 });
			if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "test-code", code_verifier: "test-verifier", code_challenge: "test-challenge" });
			if (url.endsWith("/oauth/token")) return Response.json({ access_token: jwt(Date.now() / 1000 + 3600), refresh_token: "test-refresh", expires_in: 3600 });
			throw new Error("Unexpected request");
		}) as typeof fetch;
		const credentials = new CodexCredentialStore(join(directory, "auth.json"));
		const login = new CodexLogin(credentials);
		try {
			const started = login.start("openai-codex", "device_code");
			for (let i = 0; i < 100 && login.status(started.id).status === "pending"; i++) await new Promise(resolve => setTimeout(resolve, 20));
			expect(login.status(started.id).status).toBe("complete");
			expect(JSON.stringify(login.status(started.id))).not.toContain("test-refresh");
			expect((await credentials.read("openai-codex"))?.type).toBe("oauth");
		} finally { login.cancel(); globalThis.fetch = originalFetch; }
	}));
});
