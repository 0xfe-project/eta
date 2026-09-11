/**
 * The only Solid-shaped test entry. Specs must not import
 * `@solidjs/testing-library` or `solid-js` directly.
 */
import { cleanup, fireEvent, render as renderTree } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { byId } from "./dom.ts";

export function render(node: JSX.Element) {
	return renderTree(() => node);
}

export function flush(run: () => void): void {
	run();
}

export function click(id: string): void {
	fireEvent.click(byId(id));
}

export function setField(id: string, value: string): void {
	const node = byId(id);
	fireEvent.input(node, { target: { value } });
	fireEvent.change(node, { target: { value } });
}

export function keyDown(id: string, key: string, init: KeyboardEventInit = {}): void {
	fireEvent.keyDown(byId(id), { key, ...init });
}

/** Composition events, which `fireEvent` has no shorthand for. */
export function composition(id: string, phase: "start" | "end", data = "拼音"): void {
	fireEvent(byId(id), new CompositionEvent(`composition${phase}`, { bubbles: true, data }));
}

/**
 * An Enter whose flags the harness forges by hand. `keyCode` is a prototype getter
 * in jsdom, so it cannot ride along in KeyboardEventInit — and it is the only flag
 * some engines leave behind, so a test that cannot set it cannot cover them.
 */
export function imeEnter(id: string, shape: { isComposing?: boolean; keyCode?: number }): void {
	const event = new KeyboardEvent("keydown", {
		key: "Enter",
		bubbles: true,
		cancelable: true,
		isComposing: shape.isComposing ?? false,
	});
	if (shape.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: shape.keyCode });
	byId(id).dispatchEvent(event);
}

export { cleanup };
