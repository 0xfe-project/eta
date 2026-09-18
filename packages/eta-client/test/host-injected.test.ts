// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { apiFetch, host, nativeAvailable } from "../src/lib/host.ts";

/**
 * A backend that owns a machine's sessions serves its own page too, and requires its
 * token from that page like from any other client — so the credential arrives in the
 * document, not by leaving a route open. The host is read on first use, so this file
 * declares it the way the server does: before any of our code runs.
 */
(window as unknown as { __ETA_HOST__: unknown }).__ETA_HOST__ = {
	apiBase: "",
	token: "machine-token",
	platform: "darwin",
	appVersion: "0.1.0",
	role: "service",
	native: false,
};

describe("host resolution for a backend-served page", () => {
	it("keeps the credential and the role it was handed", () => {
		const resolved = host();
		expect(resolved.kind).toBe("browser");
		expect(resolved.apiBase).toBe("");
		expect(resolved.token).toBe("machine-token");
		expect(resolved.role).toBe("service");
		expect(nativeAvailable()).toBe(false);
	});

	it("sends the credential on API calls and socket urls", async () => {
		const calls: RequestInit[] = [];
		const real = globalThis.fetch;
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			calls.push(init ?? {});
			return new Response("[]");
		}) as typeof fetch;
		await apiFetch("/api/sessions");
		globalThis.fetch = real;
		const headers = new Headers(calls[0]?.headers);
		expect(headers.get("authorization")).toBe("Bearer machine-token");
	});
});
