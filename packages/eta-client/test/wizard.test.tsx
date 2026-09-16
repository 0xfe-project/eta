// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { byId, findId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { cleanup, click, flush, render, setField } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

/**
 * `/new` renders the same `Welcome` surface the empty sessions page shows, so these specs
 * are about the two things the route adds: the way back, and the folder it hands over.
 */
async function mountWizard(initial = "/new") {
	const { NewSessionPage } = await import("../src/pages/new-session-page.tsx");
	render(
		<MemoryRouter initial={initial}>
			<Route path="/new" component={NewSessionPage} />
			<Route path="/" component={() => <div data-testid="home">home</div>} />
		</MemoryRouter>,
	);
}

const personas = [
	{ id: "Thinker", name: "Thinker", description: "INTP card" },
	{ id: "Executor", name: "Executor", description: "doer card" },
];

describe("new session surface", () => {
	// Every spec mounts a listener on `window` (personas, settings, the shell's ⌘O), so the
	// tree from the one before it must be gone or the next assertion answers for both.
	afterEach(cleanup);

	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => ({
				ok: true,
				json: async () => personas,
			})),
		);
	});

	it("needs a persona before a session can open empty, and sends session.create", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		expect(byId("persona-chips").children).toHaveLength(2);
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(true);

		click("persona-Executor");
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false);
		click("create-session");

		expect(FakeSocket.last()).toMatchObject({ op: "session.create", personaId: "Executor" });
		expect(await findId("home")).toBeTruthy();
	});

	it("sends a first message without a persona and lets the server pick", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		// Nothing picked yet, so the line above the composer explains what sending will do.
		expect(byId("persona-hint").textContent!.trim().length).toBeGreaterThan(0);
		setField("composer-input", "帮我把这个模块拆开");
		click("composer-submit");

		const sent = FakeSocket.last() as Record<string, unknown>;
		expect(sent).toMatchObject({ op: "session.create", prompt: "帮我把这个模块拆开" });
		expect("personaId" in sent).toBe(false);
	});

	it("sends the folder with the session, and writes it back as the default when asked", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		setField("composer-cwd", "/work/eta");
		click("cwd-remember");
		click("persona-Thinker");
		click("create-session");

		expect(FakeSocket.last()).toMatchObject({ op: "session.create", personaId: "Thinker", cwd: "/work/eta" });
		const posted = vi
			.mocked(fetch)
			.mock.calls.filter(([input, init]) => String(input).endsWith("/api/settings") && (init as RequestInit | undefined)?.method === "POST");
		expect(posted.map(([input, init]) => [String(input), (init as RequestInit).body])).toContainEqual(["/api/settings", JSON.stringify({ cwd: "/work/eta" })]);
	});

	it("takes the folder of the group that asked, and says so under the composer", async () => {
		await mountWizard(`/new?cwd=${encodeURIComponent("/work/from-group")}`);
		await findId("persona-Thinker");
		expect((byId("composer-cwd") as HTMLInputElement).value).toBe("/work/from-group");
		expect(byId("cwd-hint").textContent).toContain("/work/from-group");
	});

	it("gives the transcript area back when closed", async () => {
		await mountWizard();
		await findId("persona-Thinker");
		// A browser tab has no folder dialog to reach, so it gets no dead button for one.
		expect(queryId("cwd-browse")).toBeNull();
		click("new-close");
		expect(await findId("home")).toBeTruthy();
	});

	it("wears the same chrome as the session it steps in front of", async () => {
		await mountWizard();
		await findId("sidebar");
		expect(queryId("drawer-right")).not.toBeNull();

		// …and the list is a way out: picking a session focuses it and leaves `/new`.
		const socket = FakeSocket.instances.at(-1)!;
		flush(() => socket.fire("open", {}));
		flush(() => socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", badges: [], personas: [], cwd: "/work/chrome" }], attach: "s1" }) }));
		await findId("session-row-s1");
		click("session-row-s1");
		expect(FakeSocket.last()).toMatchObject({ op: "focus", session: "s1" });
		expect(await findId("home")).toBeTruthy();
	});
});
