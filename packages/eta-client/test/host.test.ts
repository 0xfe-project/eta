// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { apiUrl, apiFetch, host, wsUrl } from "../src/lib/host.ts";

/**
 * Every other test hands the store a literal `ws://test/ws`, so nothing covered
 * the one place a real page builds its own url — and a scheme written as `ws//`
 * is still a legal string, just not a legal url.
 */
describe("host resolution in a browser tab", () => {
	it("stays same-origin for /api, so the vite proxy is enough", () => {
		expect(host().kind).toBe("browser");
		expect(apiUrl("/api/sessions")).toBe("/api/sessions");
		expect(apiUrl("api/sessions")).toBe("/api/sessions");
	});

	it("builds an absolute ws url with the scheme colon intact", () => {
		const expected = `ws://${window.location.host}/ws?viewPatch`;
		// `ws//host/ws` has no colon: the browser reads it as a relative path and
		// resolves it against the page, yielding ws://host/ws//host/ws?viewPatch.
		expect(wsUrl("/ws?viewPatch")).toBe(expected);
		expect(wsUrl("/ws")).toMatch(/^wss?:\/\/[^/]+\/ws$/);
	});

	it("leaves an already absolute url alone", () => {
		expect(wsUrl("ws://127.0.0.1:9000/ws")).toBe("ws://127.0.0.1:9000/ws");
	});

	it("sends a browser request without an authorization header", async () => {
		const calls: RequestInit[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			calls.push(init ?? {});
			return new Response("[]");
		}) as typeof fetch;
		await apiFetch("/api/sessions");
		globalThis.fetch = real;
		expect(calls).toEqual([{}]);
	});
});


describe("desktop capability routing", () => {
	it("routes native APIs to the window and sessions to the shared backend", async () => {
		const previous = window.__ETA_HOST__;
		vi.resetModules();
		window.__ETA_HOST__ = {
			apiBase: "http://127.0.0.1:31000", token: "backend-token", native: true,
			nativeApiBase: "http://127.0.0.1:31001", nativeToken: "window-token",
		};
		try {
			const { apiFetch, nativeAvailable } = await import("../src/lib/host.ts");
			const mock = vi.fn(async () => new Response("{}"));
			vi.stubGlobal("fetch", mock);
			expect(nativeAvailable()).toBe(true);
			await apiFetch("/api/native/folder-dialog", { method: "POST" });
			await apiFetch("/api/sessions");
			await apiFetch("/api/remote/mac-mini/api/providers");
			const calls = mock.mock.calls as unknown as [string, RequestInit][];
			expect(calls[0]![0]).toBe("http://127.0.0.1:31001/api/native/folder-dialog");
			expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer window-token");
			expect(calls[1]![0]).toBe("http://127.0.0.1:31000/api/sessions");
			expect(calls[2]![0]).toBe("http://127.0.0.1:31000/api/remote/mac-mini/api/providers");
			for (const call of calls.slice(1)) expect(new Headers(call[1].headers).get("authorization")).toBe("Bearer backend-token");
		} finally {
			window.__ETA_HOST__ = previous;
			vi.unstubAllGlobals();
			vi.resetModules();
		}
	});
});
