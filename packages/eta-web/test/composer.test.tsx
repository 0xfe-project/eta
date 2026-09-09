// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

class FakeSocket {
	static sent: string[] = [];
	readyState = 1;
	addEventListener(): void {}
	close(): void {}
	send(data: string): void {
		FakeSocket.sent.push(data);
	}
}

const view = {
	messages: [],
	systems: [],
	thinking: [],
	compactionEpoch: 0,
	subagents: [],
	tasks: [],
	loops: [],
	sideThread: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	cacheRate: 0,
	branch: { tipId: null },
	personas: [],
	stateKeys: [],
	prompt: undefined,
	tokensPerSec: 0,
	goal: undefined,
	memory: undefined,
	pendingAsk: undefined,
	pendingAskDeadline: undefined,
} as never;

describe("composer keyboard semantics", () => {
	beforeEach(() => {
		FakeSocket.sent = [];
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ["src", "package.json", "README.md"] })));
	});

	const last = () => JSON.parse(FakeSocket.sent.at(-1)!) as Record<string, unknown>;

	it("Enter sends a prompt op", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk={false} />);
		fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hello" } });
		fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
		expect(last()).toMatchObject({ op: "prompt", session: "s1", text: "hello" });
	});

	it("empty Enter while running aborts instead of prompting", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running hasPendingAsk={false} />);
		fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
		expect(last()).toEqual({ op: "abort", session: "s1" });
	});

	it("@ opens the mention popup and Enter picks the first file", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk={false} />);
		const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "look at @pack" } });
		const popup = await screen.findByTestId("mention-popup");
		expect(popup.textContent).toContain("package.json");
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input.value).toContain("@package.json");
	});

	it("pending ask disables the composer submit", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk />);
		fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "too eager" } });
		expect((screen.getByTestId("composer-submit") as HTMLButtonElement).disabled).toBe(true);
	});
});
