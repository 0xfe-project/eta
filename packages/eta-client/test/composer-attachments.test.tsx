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

function mountComposer(running = false) {
	const page = render(<Composer session="s1" running={running} />);
	const socket = FakeSocket.instances.at(-1);
	socket?.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", personas: [], badges: [] }], attach: "s1" }) });
	socket?.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", version: 1, view: {
		messages: [], systems: [], thinking: [], queue: [], tasks: [], loops: [], subagents: [], sideThread: [], stateKeys: [],
		compactionEpoch: 0, model: "vision:test", modelInput: ["text", "image"], thinkingLevel: "off",
	} }) });
	return page;
}

describe("composer attachments", () => {
	for (const source of ["paste", "drop", "image picker", "file picker"] as const) {
		it(`${source} sends image bytes with the first prompt`, async () => {
			mountComposer();
			setField("composer-input", "inspect");
			const file = screenshot();
			if (source === "paste") paste(file);
			else if (source === "drop") fireEvent.drop(byId("composer-input"), { dataTransfer: { files: [file] } });
			else {
				const selector = source === "image picker" ? 'input[accept="image/*"]' : 'input[type="file"]:not([accept])';
				fireEvent.change(document.querySelector(selector)!, { target: { files: [file] } });
			}
			await findId("attach-chip-0");
			expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/api\/(upload|files)/.test(String(url)))).toBe(false);
			expect((byId("composer-input") as HTMLTextAreaElement).value).toBe("inspect");
			keyDown("composer-input", "Enter");
			expect(FakeSocket.last()).toMatchObject({
				op: "prompt", text: "inspect",
				images: [{ mime: "image/png", dataBase64: btoa("image bytes") }],
			});
		});
	}

	it("sends only an image while running without treating it as abort", async () => {
		mountComposer(true);
		paste(screenshot());
		await findId("attach-chip-0");
		expect((byId("composer-input") as HTMLTextAreaElement).value).toBe("");
		expect(byId("composer-submit").textContent).toMatch(/send|发送/i);
		keyDown("composer-input", "Enter", { metaKey: true });
		expect(FakeSocket.last()).toEqual({ op: "prompt", session: "s1", text: "", mode: "steer",
			images: [{ mime: "image/png", dataBase64: btoa("image bytes") }] });
		expect(document.querySelector('[data-testid="attach-chip-0"]')).toBeNull();
	});

	it("blocks sending while the image is being read", async () => {
		mountComposer();
		setField("composer-input", "inspect");
		paste(screenshot());
		FakeSocket.sent = [];
		keyDown("composer-input", "Enter");
		expect(FakeSocket.sent).toEqual([]);
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(true);
		await findId("attach-chip-0");
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(false);
	});

	it("removing the image leaves the draft unchanged and removes the payload", async () => {
		mountComposer();
		setField("composer-input", "inspect");
		paste(screenshot());
		await findId("attach-chip-0");
		click("attach-chip-drop-0");
		keyDown("composer-input", "Enter");
		expect(FakeSocket.last()).toEqual({ op: "prompt", session: "s1", text: "inspect" });
	});

	it("unknown slash prompts keep images when steering", async () => {
		mountComposer(true);
		setField("composer-input", "/explain");
		paste(screenshot());
		await findId("attach-chip-0");
		keyDown("composer-input", "Enter", { metaKey: true });
		expect(FakeSocket.last()).toMatchObject({ mode: "steer", images: [{ mime: "image/png", dataBase64: btoa("image bytes") }] });
	});

	it("blocks image pick, paste and drop for a known text-only model", async () => {
		const page = mountComposer();
		const socket = FakeSocket.instances.at(-1)!;
		socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", personas: [], badges: [] }], attach: "s1" }) });
		socket.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", version: 1, view: {
			messages: [], systems: [], thinking: [], queue: [], tasks: [], loops: [], subagents: [], sideThread: [], stateKeys: [],
			compactionEpoch: 0, model: "deepseek:deepseek-v4-pro", modelInput: ["text"], thinkingLevel: "off",
		} }) });
		click("composer-plus");
		await vi.waitFor(() => expect((byId("attach-image") as HTMLButtonElement).disabled).toBe(true));
		paste(screenshot());
		await vi.waitFor(() => expect(page.getByRole("alert").textContent).toMatch(/未声明图片输入能力|does not declare image input/));
		expect(page.queryByTestId("attach-chip-0")).toBeNull();
		expect(FakeSocket.sent.some(raw => JSON.parse(raw).op === "prompt")).toBe(false);
	});

	it("ordinary uploads and @ mentions remain references, not inline contents", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/api/upload")
			? { path: ".eta-attachments/notes.txt" } : ["README.md"])));
		mountComposer();
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
		mountComposer();
		paste(new File(["notes"], "notes.txt", { type: "text/plain" }));
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("notes.txt"));
		expect((byId("composer-submit") as HTMLButtonElement).disabled).toBe(false);
		expect(document.querySelector('[data-testid="attach-chip-0"]')).toBeNull();
	});
});
