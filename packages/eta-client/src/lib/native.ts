/**
 * The native shell's way in.
 *
 * A menu item lives in the OS menu bar, so it cannot call a Solid action; the
 * shell pushes a `{type:"native"}` frame down the same WebSocket the browser
 * uses, the store turns it into an `eta:native` window event, and whatever
 * component can act on it listens here. Same shape as the existing `eta:view`
 * and `eta:personas` events, so a browser tab simply never fires them and needs
 * no branch.
 *
 * Actions are plain strings shared with the shell (`packages/eta-desktop`), not
 * an enum imported from it: the web build must not depend on electrobun.
 */
import { apiFetch } from "./host.ts";

export const NATIVE_EVENT = "eta:native";

/** Kept in sync with the shell's menu action table. */
export const NativeActions = {
	toggleSidebar: "view.toggle-sidebar",
	togglePanel: "view.toggle-panel",
	commandPalette: "view.command-palette",
	newSession: "nav.new-session",
	abort: "session.abort",
	compact: "session.compact",
	openFolder: "file.open-folder",
	quit: "app.quit",
} as const;

export type NativeAction = (typeof NativeActions)[keyof typeof NativeActions];

export interface NativeDetail {
	kind: "menu" | "tray" | "update";
	action: string;
	data?: unknown;
}

/** Listen for one or more named actions; returns the detach. */
export function onNativeActions(handlers: Record<string, (detail: NativeDetail) => void>): () => void {
	const onEvent = (event: Event) => {
		const detail = (event as CustomEvent<NativeDetail>).detail;
		if (detail === undefined || typeof detail.action !== "string") return;
		handlers[detail.action]?.(detail);
	};
	window.addEventListener(NATIVE_EVENT, onEvent);
	return () => window.removeEventListener(NATIVE_EVENT, onEvent);
}

/** Fire one as if the shell had; used by tests, and left on `window` so a menu
 * item can be smoke-tested from the devtools console before the shell exists. */
export function emitNative(detail: NativeDetail): void {
	window.dispatchEvent(new CustomEvent(NATIVE_EVENT, { detail }));
}

declare global {
	interface Window {
		__etaNative?: (detail: NativeDetail) => void;
	}
}

if (typeof window !== "undefined") window.__etaNative = emitNative;

export interface NativeInfo {
	isDesktop: boolean;
	platform: string;
	appVersion: string;
}

/** Present only in the desktop shell; a browser tab gets null. */
export async function nativeInfo(): Promise<NativeInfo | null> {
	try {
		const response = await apiFetch("/api/native/info");
		if (!response.ok) return null;
		return (await response.json()) as NativeInfo;
	} catch {
		return null;
	}
}

/** Ask the shell for a folder; null means the user cancelled or there is no shell. */
export async function pickFolder(startingFolder?: string): Promise<string | null> {
	try {
		const response = await apiFetch("/api/native/folder-dialog", {
			method: "POST",
			body: JSON.stringify(startingFolder === undefined ? {} : { startingFolder }),
			headers: { "content-type": "application/json" },
		});
		if (!response.ok) return null;
		return ((await response.json()) as { path: string | null }).path;
	} catch {
		return null;
	}
}
