// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/features/sessions/composer.tsx";
import { byId, findId } from "./dom.ts";
import { FakeSocket } from "./fake-socket.ts";
import { click, fireEvent, keyDown, render, setField } from "./render.tsx";

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/api/upload")
		? { path: ".eta-attachments/screenshot.png" } : ["README.md"])));
});

const screenshot = () => new File(["image bytes"], "screenshot.png", { type: "image/png" });
const paste = (file: File) => fireEvent.paste(byId("composer-input"), { clipboardData: { files: [file] } });

describe("composer attachments", () => {
	for (const source of ["paste", "drop", "image picker", "file picker"] as const) {
		it(`${source} sends image bytes with the first prompt`, async () => {
			render(<Composer session="s1" />);
			setField("composer-input", "inspect");
			const file = screenshot();
			if (source === "paste") paste(file);
			else if (source === "drop") fireEvent.drop(byId("composer-input"), { dataTransfer: { files: [file] } });
			else {
				const selector = source === "image picker" ? 'input[accept="image/*"]' : 'input[type="file"]:not([accept])';
				fireEvent.change(document.querySelector(selector)!, { target: { files: [file] } });
			}
			await findId("attach-chip-0");
			expect((byId("composer-input") as HTMLTextAreaElement).value).toBe("inspect");
			keyDown("composer-input", "Enter");
			expect(FakeSocket.last()).toMatchObject({
				op: "prompt", text: "inspect",
				images: [{ mime: "image/png", dataBase64: btoa("image bytes") }],
			});
		});
	}

	it("sends only an image while running without treating it as abort", async () => {
		render(<Composer session="s1" running />);
		paste(screenshot());
		await findId("attach-chip-0");
		expect((byId("composer-input") as HTMLTextAreaElement).value).toBe("");
		expect(byId("composer-submit").textContent).toMatch(/send|发送/i);
		keyDown("composer-input", "Enter", { metaKey: true });
		expect(FakeSocket.last()).toEqual({ op: "prompt", session: "s1", text: "", mode: "steer",
			images: [{ mime: "image/png", dataBase64: btoa("image bytes") }] });
		expect(document.querySelector('[data-testid="attach-chip-0"]')).toBeNull();
	});

	it("blocks sending until an upload finishes", async () => {
		let finish!: (response: Response) => void;
		vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/api/upload")
			? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(Response.json([]))));
		render(<Composer session="s1" />);
		setField("composer-input", "inspect");
		paste(screenshot());
		FakeSocket.sent = [];
		keyDown("composer-input", "Enter");
		expect(FakeSocket.sent).toEqual([]);
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(true);
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		finish(Response.json({ path: ".eta-attachments/screenshot.png" }));
		await findId("attach-chip-0");
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(false);
	});

	it("removing the image leaves the draft unchanged and removes the payload", async () => {
		render(<Composer session="s1" />);
		setField("composer-input", "inspect");
		paste(screenshot());
		await findId("attach-chip-0");
		click("attach-chip-drop-0");
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toEqual({ op: "prompt", session: "s1", text: "inspect" });
	});

	it("unknown slash prompts keep images when steering", async () => {
		render(<Composer session="s1" running />);
		setField("composer-input", "/explain");
		paste(screenshot());
		await findId("attach-chip-0");
		keyDown("composer-input", "Enter", { metaKey: true });
		expect(FakeSocket.last()).toMatchObject({ mode: "steer", images: [{ mime: "image/png", dataBase64: btoa("image bytes") }] });
	});

	it("ordinary uploads and @ mentions remain references, not inline contents", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/api/upload")
			? { path: ".eta-attachments/notes.txt" } : ["README.md"])));
		render(<Composer session="s1" />);
		setField("composer-input", "read @READ");
		await findId("mention-README.md");
		keyDown("composer-input", "Enter");
		paste(new File(["private file contents"], "notes.txt", { type: "text/plain" }));
		await vi.waitFor(() => expect((byId("composer-input") as HTMLTextAreaElement).value).toContain("@.eta-attachments/notes.txt"));
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toEqual({ op: "prompt", session: "s1", text: "read @README.md @.eta-attachments/notes.txt" });
	});

	it("failed uploads show an error and release the send button", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/api/upload")
			? Response.json({ error: "failed" }, { status: 500 }) : Response.json([])));
		render(<Composer session="s1" />);
		paste(screenshot());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("screenshot.png"));
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(false);
		expect(document.querySelector('[data-testid="attach-chip-0"]')).toBeNull();
	});
});
