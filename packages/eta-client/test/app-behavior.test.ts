// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAppBehavior } from "../src/lib/app-behavior.ts";

/**
 * The rules in lib/app-behavior.ts are mostly invisible — a preventDefault that
 * stops something from happening leaves nothing on screen — so what these assert is
 * the shape of the exemption list rather than the suppression itself: an app that
 * kills the web menu everywhere is as wrong as one that keeps it, because the
 * terminal, the inputs and the message bodies all need theirs back.
 *
 * Events are built by hand (`new Event` plus a `dataTransfer` stub) rather than
 * through DragEvent/WheelEvent: jsdom has neither constructor, and the module reads
 * `target instanceof Element` and `dataTransfer` off whatever it is handed.
 */

let detach: (() => void) | undefined;

/** One node to dispatch from, mounted so `closest()` sees the same tree a page has. */
function mount(html: string): HTMLElement {
	const host = document.createElement("div");
	host.innerHTML = html;
	document.body.append(host);
	return host;
}

function fire(node: Element, type: string, init: EventInit & Record<string, unknown> = {}, dataTransfer?: unknown): Event {
	// The event has to be the class the handler reads its flags off: `key` on an
	// ordinary Event is undefined, so a cmd+R built as `new Event` would prove nothing.
	const Ctor = type === "keydown" ? KeyboardEvent : type === "wheel" ? MouseEvent : type === "click" || type === "mousedown" || type === "contextmenu" ? MouseEvent : Event;
	const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
	if (dataTransfer !== undefined) Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	node.dispatchEvent(event);
	return event;
}

const FILES = { types: ["Files"], files: [] };

afterEach(() => {
	detach?.();
	detach = undefined;
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe("default behaviour an app must not have", () => {
	it("takes the web context menu off chrome", () => {
		detach = installAppBehavior();
		const node = mount('<div data-testid="shell"><button type="button">新会话</button></div>');
		expect(fire(node.querySelector("button")!, "contextmenu").defaultPrevented).toBe(true);
	});

	it("leaves the menu to an input, where cut/copy/paste is worth the clutter", () => {
		detach = installAppBehavior();
		const node = mount('<textarea data-testid="composer-input"></textarea>');
		expect(fire(node.querySelector("textarea")!, "contextmenu").defaultPrevented).toBe(false);
	});

	it("opens a link outside instead of replacing the app", () => {
		detach = installAppBehavior();
		const opened: string[] = [];
		vi.stubGlobal("open", (url: string) => {
			opened.push(url);
			return null;
		});
		const node = mount('<p class="markdown"><a href="https://example.com/doc">docs</a></p>');
		expect(fire(node.querySelector("a")!, "click", { button: 0 }).defaultPrevented).toBe(true);
		expect(opened).toEqual(["https://example.com/doc"]);
	});

	it("leaves the router alone: a relative link is the app navigating", () => {
		detach = installAppBehavior();
		const node = mount('<a href="/settings">设置</a>');
		expect(fire(node.querySelector("a")!, "click", { button: 0 }).defaultPrevented).toBe(false);
	});

	it("leaves the router alone even when the link is written out in full", () => {
		detach = installAppBehavior();
		// `a.href` comes back absolute, so this is the same click as above as far as
		// the handler can see — and it is the one that used to open a new tab on top
		// of the app.
		const node = mount(`<a href="${window.location.origin}/new">新会话</a>`);
		expect(fire(node.querySelector("a")!, "click", { button: 0 }).defaultPrevented).toBe(false);
	});

	it("refuses to let a logo be dragged, or a dropped file navigate the page", () => {
		detach = installAppBehavior();
		const node = mount('<div class="topbar"><img src="/Eta-Logo.svg" alt="eta"></div>');
		expect(fire(node.querySelector("img")!, "dragstart").defaultPrevented).toBe(true);
		expect(fire(node, "dragover", {}, FILES).defaultPrevented).toBe(true);
		expect(fire(node, "drop", {}, FILES).defaultPrevented).toBe(true);
	});

	it("keeps cmd+wheel from rescaling the layout, and plain wheel for scrolling", () => {
		detach = installAppBehavior();
		const node = mount('<div class="markdown"><pre><code>ls</code></pre></div>');
		expect(fire(node, "wheel", { ctrlKey: true }).defaultPrevented).toBe(true);
		expect(fire(node, "wheel", {}).defaultPrevented).toBe(false);
	});
});

/**
 * The terminal is the one subtree where the browser's mouse belongs to somebody
 * else: xterm paints its own selection, listens for paste on its own element, and
 * scrolls its scrollback with the wheel. Every rule above has to step aside here.
 */
describe("the terminal keeps its own mouse", () => {
	const TERMINAL = '<div data-testid="term-host" data-app-menu class="xterm"><div class="xterm-screen">ls</div></div>';

	it("answers its own context menu", () => {
		detach = installAppBehavior();
		const node = mount(TERMINAL);
		expect(fire(node.querySelector(".xterm-screen")!, "contextmenu").defaultPrevented).toBe(false);
	});

	it("lets a dropped file through to the paste handler instead of swallowing it twice", () => {
		detach = installAppBehavior();
		const node = mount(TERMINAL);
		// The component's own drop handler stops propagation, so the document rule
		// never runs; a drop that reaches the document must still not navigate.
		expect(fire(node.querySelector(".xterm-screen")!, "drop", {}, FILES).defaultPrevented).toBe(true);
	});

	it("leaves ctrl+wheel to a mouse-reported app: tmux binds it, the layout does not", () => {
		detach = installAppBehavior();
		const node = mount(TERMINAL);
		expect(fire(node.querySelector(".xterm-screen")!, "wheel", { ctrlKey: true }).defaultPrevented).toBe(false);
	});

	it("leaves middle-click alone: middle-click paste is a terminal convention", () => {
		detach = installAppBehavior();
		const node = mount(TERMINAL);
		expect(fire(node.querySelector(".xterm-screen")!, "mousedown", { button: 1 }).defaultPrevented).toBe(false);
	});
});

describe("shell shortcuts", () => {
	it("swallows cmd+R in the shell, and nothing inside a terminal", async () => {
		// host() decides once, on first read, so the shell has to be described
		// before a fresh copy of the module is loaded.
		vi.resetModules();
		window.__ETA_HOST__ = { apiBase: "http://127.0.0.1:5174", token: "t", platform: "darwin" };
		const fresh = await import("../src/lib/app-behavior.ts");
		const stop = fresh.installAppBehavior();
		try {
			const node = mount('<div data-testid="term-host" class="xterm"><div class="xterm-viewport"></div></div>');
			const outside = mount("<div>chrome</div>");
			const inTerminal = fire(node.querySelector(".xterm-viewport")!, "keydown", { key: "r", metaKey: true });
			const elsewhere = fire(outside, "keydown", { key: "r", metaKey: true });
			expect(inTerminal.defaultPrevented).toBe(false);
			expect(elsewhere.defaultPrevented).toBe(true);
		} finally {
			stop();
			delete window.__ETA_HOST__;
		}
	});
});
