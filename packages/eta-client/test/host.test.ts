// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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
