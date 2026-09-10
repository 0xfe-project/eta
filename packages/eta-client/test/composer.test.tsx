// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId, findId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { keyDown, render, setField } from "./render.tsx";

describe("composer keyboard semantics", () => {
	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ["src", "package.json", "README.md"] })));
	});

	it("Enter sends a prompt op", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk={false} />);
		setField("composer-input", "hello");
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toMatchObject({ op: "prompt", session: "s1", text: "hello" });
	});

	it("empty Enter while running aborts instead of prompting", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running hasPendingAsk={false} />);
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toEqual({ op: "abort", session: "s1" });
	});

	it("@ opens the mention popup and Enter picks the first file", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk={false} />);
		setField("composer-input", "look at @pack");
		expect((await findId("mention-package.json")).textContent).toContain("package.json");
		keyDown("composer-input", "Enter");
		expect((byId("composer-input") as HTMLTextAreaElement).value).toContain("@package.json");
	});

	it("slash /ab lists commands and Enter runs abort", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk={false} />);
		setField("composer-input", "/ab");
		expect(await findId("slash-abort")).toBeTruthy();
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toEqual({ op: "abort", session: "s1" });
	});

	it("pending ask disables the composer submit", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk />);
		setField("composer-input", "too eager");
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(true);
	});
});
