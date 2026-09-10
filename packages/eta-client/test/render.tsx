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

export { cleanup };
