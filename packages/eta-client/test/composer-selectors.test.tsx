// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/features/sessions/composer.tsx";
import { byId } from "./dom.ts";
import { render, click, setField, keyDown, fireEvent } from "./render.tsx";
import { FakeSocket } from "./fake-socket.ts";

const models = [{ id: "deepseek:flash", label: "DeepSeek Flash" }, { id: "kimi:code", label: "Kimi for Coding" }];

beforeEach(() => {
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/api/models")
		? { models, current: models[0]!.id } : ["src/main.ts"])));
});

async function mount() {
	const rendered = render(<Composer session="s1" running={false} />);
	const socket = FakeSocket.instances[0]!;
	socket.fire("message", { data: JSON.stringify({ type: "hello", sessions: [{ name: "s1", personas: [], badges: [] }], attach: "s1" }) });
	const view = (model: string, thinkingLevel = "high") => socket.fire("message", { data: JSON.stringify({ channel: "view", session: "s1", version: 1, view: {
		messages: [], systems: [], thinking: [], queue: [], tasks: [], loops: [], subagents: [], sideThread: [], stateKeys: [],
		compactionEpoch: 0, model, thinkingLevel, supportedThinkingLevels: ["off", "low", "high", "max"],
	} }) });
	view(models[0]!.id);
	await vi.waitFor(() => expect(byId("model-picker").textContent).toContain("DeepSeek Flash"));
	FakeSocket.sent = [];
	return { ...rendered, view };
}

describe("composer selection menus", () => {
	it("opens an upward model menu outside the form and does not submit the draft", async () => {
		const page = await mount();
		setField("composer-input", "unsent message");
		click("model-picker");
		expect(byId("model-menu").closest("form")).toBeNull();
		expect(byId("model-menu").style.position).toBe("fixed");
		expect(byId("model-menu").getAttribute("data-side")).toBe("top");
		expect(byId("model-picker").getAttribute("aria-expanded")).toBe("true");
		expect(FakeSocket.sent).toEqual([]);
		click("model-kimi:code");
		expect(FakeSocket.last()).toEqual({ op: "modelSet", session: "s1", modelId: "kimi:code" });
		expect(document.querySelector('[data-testid="model-menu"]')).toBeNull();
		expect((byId("composer-input") as HTMLTextAreaElement).value).toBe("unsent message");
		page.view("kimi:code");
		expect(byId("model-picker").textContent).toContain("Kimi for Coding");
		expect(page.queryByTestId("model-pending")).toBeNull();
	});

	it("selects a thinking level explicitly instead of cycling on click", async () => {
		await mount();
		click("thinking-chip");
		expect(FakeSocket.sent).toEqual([]);
		expect(byId("thinking-menu").getAttribute("data-side")).toBe("top");
		expect([...byId("thinking-menu").querySelectorAll('[role="menuitemradio"]')].map(node => node.textContent?.replace("✓", ""))).toEqual(["off", "low", "high", "max"]);
		click("thinking-option-max");
		expect(FakeSocket.last()).toEqual({ op: "thinkingLevel", session: "s1", level: "max" });
		expect(document.querySelector('[data-testid="thinking-menu"]')).toBeNull();
		expect(document.activeElement).toBe(byId("thinking-chip"));
	});

	it("supports keyboard opening, Escape and outside-pointer dismissal", async () => {
		await mount();
		keyDown("model-picker", "ArrowUp");
		expect(document.activeElement).toBe(byId("model-kimi:code"));
		keyDown("model-kimi:code", "Escape");
		expect(document.querySelector('[data-testid="model-menu"]')).toBeNull();
		expect(document.activeElement).toBe(byId("model-picker"));
		click("model-picker");
		fireEvent.pointerDown(document.body);
		expect(document.querySelector('[data-testid="model-menu"]')).toBeNull();
		expect(FakeSocket.sent).toEqual([]);
	});

	it("removes duplicate model/thinking controls and model fetches from the plus panel", async () => {
		await mount();
		const count = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/api/models")).length;
		const before = count();
		click("composer-plus");
		await vi.waitFor(() => expect(byId("toolbox-file-src/main.ts")).toBeTruthy());
		const toolbox = byId("composer-toolbox");
		expect(toolbox.querySelector('[data-testid="toolbox-models"]')).toBeNull();
		expect(toolbox.querySelector('[data-testid="toolbox-thinking"]')).toBeNull();
		expect(toolbox.querySelector('[data-testid="toolbox-command-thinking"]')).toBeNull();
		expect(byId("attach-upload")).toBeTruthy();
		expect(byId("attach-image")).toBeTruthy();
		expect(count()).toBe(before);
	});
});
