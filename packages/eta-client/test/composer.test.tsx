// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byId, findId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { composition, imeEnter, keyDown, render, setField } from "./render.tsx";

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

	/*
	 * Three specs, one user action: press Enter to put the words on screen. Each
	 * engine reports it differently, and all three orderings were read off a real
	 * browser before being asserted here. The third is macOS Pinyin typing ASCII,
	 * which closes the composition before the Enter is delivered at all.
	 */
	const imeCases = [
		{ name: "chrome flags the key", endFirst: false, shape: { isComposing: true, keyCode: 229 } },
		{ name: "webkit leaves only keyCode 229", endFirst: false, shape: { isComposing: false, keyCode: 229 } },
		{ name: "the composition ends before the Enter arrives", endFirst: true, shape: { isComposing: false, keyCode: 13 } },
	];

	for (const testCase of imeCases) {
		it(`Enter that commits an IME composition does not send (${testCase.name})`, async () => {
			const { Composer } = await import("../src/features/sessions/composer.tsx");
			render(<Composer session="s1" running={false} hasPendingAsk={false} />);
			setField("composer-input", "拼音");
			FakeSocket.reset();
			composition("composer-input", "start");
			if (testCase.endFirst) {
				composition("composer-input", "end");
				imeEnter("composer-input", testCase.shape);
			} else {
				imeEnter("composer-input", testCase.shape);
				composition("composer-input", "end");
			}
			expect(FakeSocket.sent).toEqual([]);
		});
	}

	it("the Enter after a committed composition still sends", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running={false} hasPendingAsk={false} />);
		setField("composer-input", "拼音");
		FakeSocket.reset();
		composition("composer-input", "start");
		composition("composer-input", "end");
		await new Promise((resolve) => setTimeout(resolve, 160));
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toMatchObject({ op: "prompt", text: "拼音" });
	});

	it("cmd+Enter steers with the mention menu open, instead of picking a file", async () => {
		const { Composer } = await import("../src/features/sessions/composer.tsx");
		render(<Composer session="s1" running hasPendingAsk={false} />);
		setField("composer-input", "look at @pack");
		expect((await findId("mention-package.json")).textContent).toContain("package.json");
		keyDown("composer-input", "Enter", { metaKey: true });
		// What was typed goes out: the popup is a suggestion, not an edit.
		expect(FakeSocket.last()).toMatchObject({ op: "prompt", mode: "steer", text: "look at @pack" });
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
