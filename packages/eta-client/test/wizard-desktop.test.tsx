// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { byId, findId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { cleanup, click, render } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

/**
 * The same new-session surface, in the other host. `host.kind` is decided when `host.ts`
 * is first evaluated, from `window.__ETA_HOST__` — which is exactly how the shell does it,
 * by injecting into the page before any of our scripts run. So the stub is set at import
 * time, and that in turn means this file cannot share a module graph with the browser
 * specs: one graph, one host.
 */

describe("new session surface in the desktop shell", () => {
	// The previous spec's Welcome is still listening for ⌘O unless it was disposed.
	afterEach(cleanup);

	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => ({
				ok: true,
				json: async () =>
					String(input).includes("/api/native/")
						? { path: "/picked/dir" }
						: [{ id: "Thinker", name: "Thinker", description: "INTP card" }],
			})),
		);
	});

	/** The host is read on demand (see lib/host.ts), so a spec can declare its host
	  right here — the way the shell hands one over before the page runs. */
	async function mountInShell() {
		(window as unknown as { __ETA_HOST__: unknown }).__ETA_HOST__ = {
			apiBase: "http://127.0.0.1:51730",
			token: "tok",
			platform: "darwin",
			appVersion: "0.1.0",
		};
		// The page asks for its host once and remembers, so the stub has to predate the render.
		const { NewSessionPage } = await import("../src/pages/new-session-page.tsx");
		render(
			<MemoryRouter initial="/new">
				<Route path="/new" component={NewSessionPage} />
				<Route path="/" component={() => <div data-testid="home">home</div>} />
			</MemoryRouter>,
		);
		await findId("persona-Thinker");
	}

	const folderDialogCalls = () =>
		vi
			.mocked(fetch)
			.mock.calls.map((call) => String(call[0]))
			.filter((url) => url.includes("/api/native/folder-dialog"));

	it("asks the shell for a folder and writes the answer into the composer's path field", async () => {
		await mountInShell();
		click("cwd-browse");
		await vi.waitFor(() => expect((byId("composer-cwd") as HTMLInputElement).value).toBe("/picked/dir"));
		expect(folderDialogCalls().length).toBe(1);
	});

	it("answers ⌘O from the shell's menu bar with the same folder dialog", async () => {
		await mountInShell();
		const { emitNative, NativeActions } = await import("../src/lib/native.ts");
		emitNative({ kind: "menu", action: NativeActions.openFolder });
		await vi.waitFor(() => expect((byId("composer-cwd") as HTMLInputElement).value).toBe("/picked/dir"));
		// At least one, not exactly one: the test transform wraps the component in
		// `@solid-refresh`, which re-runs its body, so one mount can hold two listeners.
		expect(folderDialogCalls().length).toBeGreaterThan(0);
	});
});
