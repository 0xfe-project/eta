/**
 * Framework-agnostic DOM helpers for eta-web tests.
 * Assertions go through data-testid / document / protocol JSON.
 * The React (and later Solid) renderer only lives in `./render.tsx`.
 */

// vitest's jsdom environment does not forward window.CSS; the timeline rail
// escapes entry ids before querying them.
if (globalThis.CSS === undefined) {
	(globalThis as Record<string, unknown>).CSS = {
		escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`),
	};
}

export function testId(id: string): string {
	return `[data-testid="${id.replaceAll('"', '\\"')}"]`;
}

export function queryId(id: string): HTMLElement | null {
	return document.querySelector(testId(id));
}

export function byId(id: string): HTMLElement {
	const node = queryId(id);
	if (node === null) throw new Error(`missing ${testId(id)}`);
	return node;
}

export async function findId(id: string, timeoutMs = 1000): Promise<HTMLElement> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const node = queryId(id);
		if (node !== null) return node;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${testId(id)}`);
}

/** Write a controlled field via the native value setter + input/change. */
export function setField(id: string, value: string): void {
	const node = byId(id) as HTMLInputElement | HTMLTextAreaElement;
	const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter === undefined) throw new Error(`no value setter on ${testId(id)}`);
	setter.call(node, value);
	node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
	node.dispatchEvent(new Event("change", { bubbles: true }));
}

export function click(id: string): void {
	byId(id).click();
}

export function keyDown(id: string, key: string, init: KeyboardEventInit = {}): void {
	byId(id).dispatchEvent(
		new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		}),
	);
}
