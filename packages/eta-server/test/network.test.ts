import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeNetwork, parseMacProxy, readSystemProxy } from "../src/network.ts";
import { ProviderConfigStore } from "../src/providers.ts";

describe("backend network initialization", () => {
	it("uses explicit environment proxies without querying the OS", async () => {
		const env = { HTTPS_PROXY: "http://explicit:8000", NO_PROXY: ".internal" };
		const status = await initializeNetwork({ mode: "system" }, env, async () => { throw new Error("must not read OS"); });
		expect(status.source).toBe("environment");
		expect(env.HTTPS_PROXY).toBe("http://explicit:8000");
	});
	it("inherits macOS HTTP/HTTPS settings and translates domain exceptions", async () => {
		const detected = parseMacProxy(`HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 1082\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 1082\nExceptionsList : <array> {\n0 : *.internal\n1 : localhost\n}`);
		const env: Record<string, string | undefined> = {};
		expect((await initializeNetwork(undefined, env, async () => detected)).source).toBe("system");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1082");
		expect(env.https_proxy).toBe(env.HTTPS_PROXY);
		expect(env.NO_PROXY).toContain(".internal");
		expect(env.NO_PROXY).toContain("127.0.0.1");
		expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
	});
	it("manual and direct modes override inherited values including lowercase and ALL_PROXY", async () => {
		const env: Record<string, string | undefined> = { HTTPS_PROXY: "old", https_proxy: "older", ALL_PROXY: "other" };
		await initializeNetwork({ mode: "manual", proxyUrl: "http://localhost:8888", noProxy: ".internal" }, env);
		expect(env.HTTPS_PROXY).toBe("http://localhost:8888");
		expect(env.ALL_PROXY).toBeUndefined();
		await initializeNetwork({ mode: "direct" }, env);
		expect(env.https_proxy).toBe("");
		expect(env.NO_PROXY).toBe("*");
	});
	it("reads Windows proxy settings and detects PAC without executing it", async () => {
		const result = await readSystemProxy("win32", async () => JSON.stringify({ ProxyEnable: 1, ProxyServer: "http=localhost:8080;https=localhost:8081", ProxyOverride: "*.internal;<local>" }));
		expect(result.https).toBe("http://localhost:8081");
		expect(result.bypass).toBe(".internal");
		expect(parseMacProxy("ProxyAutoConfigEnable : 1").warning).toBe("pac_unsupported");
		expect((await readSystemProxy("linux", async () => "'auto'")).warning).toBe("pac_unsupported");
	});
	it("falls back with an explicit warning when system detection is unavailable", async () => {
		expect((await readSystemProxy("linux", async () => { throw new Error("missing gsettings"); })).warning).toBe("system_unavailable");
	});
	it("persists network settings without overwriting providers and rejects invalid proxy URLs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "eta-network-test-"));
		try {
			const path = join(directory, "config.json"), store = new ProviderConfigStore(path);
			const before = await store.save({ revision: (await store.view()).revision, provider: { id: "test", kind: "openai-compatible", baseUrl: "http://localhost:9999", models: [{ id: "m" }] } });
			const result = await store.setNetwork({ revision: before.revision, network: { mode: "manual", proxyUrl: "http://localhost:1082", noProxy: ".internal" } });
			expect(result.providers).toEqual(before.providers);
			expect(JSON.parse(await readFile(path, "utf8")).network.proxyUrl).toBe("http://localhost:1082/");
			expect(() => store.setNetwork({ revision: result.revision, network: { mode: "manual", proxyUrl: "http://user:secret@localhost:1082" } })).toThrow("invalid_network");
			await expect(store.setNetwork({ revision: before.revision, network: { mode: "direct" } })).rejects.toThrow("config_changed");
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
