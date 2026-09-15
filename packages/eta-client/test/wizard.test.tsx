// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { byId, findId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, render, setField } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

async function mountWizard() {
	const { NewSessionPage } = await import("../src/pages/new-session-page.tsx");
	render(
		<MemoryRouter initial="/new">
			<Route path="/new" component={NewSessionPage} />
			<Route path="/" component={() => <div data-testid="home">home</div>} />
		</MemoryRouter>,
	);
}

describe("new session wizard", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => ({
				ok: true,
				// The native endpoints answer with an object; everything else with personas.
				json: async () =>
					String(input).includes("/api/native/")
						? { path: "/picked/dir" }
						: [
								{ id: "Thinker", name: "Thinker", description: "INTP card" },
								{ id: "Executor", name: "Executor", description: "doer card" },
							],
			})),
		);
	});

	it("requires a persona before create is possible and sends session.create", async () => {
		await mountWizard();
		await findId("persona-card-Thinker");
		expect(byId("persona-grid").children).toHaveLength(2);
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(true);
		expect(queryId("persona-required")).not.toBeNull();

		click("persona-card-Executor");
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false);
		click("create-session");

		expect(FakeSocket.last()).toMatchObject({ op: "session.create", personaId: "Executor" });
		expect(await findId("home")).toBeTruthy();
	});

	it("sends without a persona once a first message is typed, and lets the server pick", async () => {
		await mountWizard();
		await findId("persona-card-Thinker");
		setField("prompt-input", "帮我把这个模块拆开");
		expect((byId("create-session") as HTMLButtonElement).disabled).toBe(false);
		expect(queryId("persona-required")).toBeNull();
		expect(queryId("persona-auto")).not.toBeNull();

		click("create-session");

		const sent = FakeSocket.last() as Record<string, unknown>;
		expect(sent).toMatchObject({ op: "session.create", prompt: "帮我把这个模块拆开" });
		expect("personaId" in sent).toBe(false);
	});

	it("gives the transcript area back when closed", async () => {
		await mountWizard();
		await findId("persona-card-Thinker");
		// A browser tab has no folder dialog to reach, so it gets no dead button for one.
		expect(queryId("cwd-browse")).toBeNull();
		click("new-close");
		expect(await findId("home")).toBeTruthy();
	});
});
