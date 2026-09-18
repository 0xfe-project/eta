/**
 * The native shell's way in.
 *
 * The desktop dispatches an `eta:native` event to its own webview. Menu clicks stay
 * in that window even when several clients share the same backend. Native HTTP
 * requests are routed by apiFetch to the window's own capability bridge.
 *
 * Actions are plain strings shared with the shell (`packages/eta-desktop`), not
 * an enum imported from it: the web build must not depend on electrobun.
 */
import { apiFetch, nativeAvailable } from "./host.ts";

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

export type NativeWindowAction = "minimize" | "toggle-maximize" | "close";

/** Control the desktop window without exposing native APIs to a browser tab. */
export async function windowAction(action: NativeWindowAction): Promise<void> {
	try {
		await apiFetch("/api/native/window-action", {
			method: "POST",
			body: JSON.stringify({ action }),
			headers: { "content-type": "application/json" },
		});
	} catch {
		// A browser tab has no native window to control.
	}
}
/** Ask the shell for a folder; null means the user cancelled or there is no shell. */
export async function pickFolder(startingFolder?: string): Promise<string | null> {
	// A browser without a native shell has no folder dialog to request.
	if (!nativeAvailable()) return null;
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
