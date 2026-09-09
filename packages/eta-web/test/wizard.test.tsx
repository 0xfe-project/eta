// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Route, Switch } from "wouter";
import { MemoryRouter } from "./memory-router.tsx";

class FakeSocket {
	static sent: string[] = [];
	readyState = 1;
	addEventListener(): void {}
	close(): void {}
	send(data: string): void {
		FakeSocket.sent.push(data);
	}
}

describe("new session wizard", () => {
	beforeEach(() => {
		FakeSocket.sent = [];
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
				<Switch>
					<Route path="/new">{<NewSessionPage />}</Route>
					<Route path="/"><div data-testid="home">home</div></Route>
				</Switch>
			</MemoryRouter>,
		);
		const grid = await screen.findByTestId("persona-grid");
		expect(grid.children).toHaveLength(2);
		const create = screen.getByTestId("create-session") as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		expect(screen.getByTestId("persona-required")).toBeTruthy();

		fireEvent.click(screen.getByTestId("persona-card-Executor"));
		expect(create.disabled).toBe(false);
		fireEvent.click(create);

		const message = JSON.parse(FakeSocket.sent.at(-1)!) as Record<string, unknown>;
		expect(message).toMatchObject({ op: "session.create", personaId: "Executor" });
		expect(screen.getByTestId("home")).toBeTruthy();
	});
});
