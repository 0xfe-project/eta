// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@solidjs/router";
import { byId, findId, queryId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, render } from "./render.tsx";
import { MemoryRouter } from "./memory-router.tsx";

describe("new session wizard", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				json: async () => [
					{ id: "Thinker", name: "Thinker", description: "INTP card" },
					{ id: "Executor", name: "Executor", description: "doer card" },
				],
			})),
		);
	});

	it("requires a persona before create is possible and sends session.create", async () => {
		const { NewSessionPage } = await import("../src/pages/new-session-page.tsx");
		render(
			<MemoryRouter initial="/new">
				<Route path="/new" component={NewSessionPage} />
				<Route path="/" component={() => <div data-testid="home">home</div>} />
			</MemoryRouter>,
		);
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
});
