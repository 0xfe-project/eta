/**
 * Everything a browser does by default that an app must not.
 *
 * A chat UI that lets you right-click a button, rubber-band the sidebar into the
 * timeline, or drag the logo into another window announces that it is a web page.
 * The rules all live here, in one install, rather than sprinkled across components,
 * for two reasons: the exemptions are the interesting part and they only make
 * sense next to the rules, and a component-local `preventDefault` is how the
 * terminal got broken the last time this was tried.
 *
 * The exemptions, in one place:
 *
 * - The terminal (`[data-testid="term-host"]`) owns its own mouse. xterm draws its
 *   own selection (`.xterm` is `user-select:none` in xterm's own stylesheet, which
 *   is why the chrome-wide rule below is a no-op inside it), listens for `paste` on
 *   the terminal element, re-focuses its hidden textarea on right-button mousedown
 *   on macOS, and scrolls its scrollback with a plain wheel — mouse-reported apps
 *   like tmux take ctrl+wheel for themselves. So: no context menu, no drag, no
 *   middle-click suppression and no zoom rule inside a terminal; the component
 *   handles its own right-click paste instead.
 * - Text meant to be read and taken: message bodies, code, inputs. Those keep
 *   selection, drag-out, and the input's own context menu.
 * - Anything marked `data-app-menu` keeps its context menu because something else
 *   is answering it.
 */
import { apiFetch, host } from "./host.ts";

/** Where selecting and dragging text out is a feature, not an accident. */
export const SELECTABLE = '.message-content, .markdown, pre, code, input, textarea, select, [contenteditable="true"], [data-selectable], .selectable';

/** xterm's mount point. Same marker app-shell keys its shortcuts off: one answer
 * for "is this event the terminal's", from both places, so they cannot drift. */
export function insideTerminal(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest('[data-testid="term-host"]') !== null;
}

function isEditable(target: Element): boolean {
	return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

function element(event: Event): Element | null {
	return event.target instanceof Element ? event.target : null;
}

/**
 * Links open in the real browser, never in this page. A relative link and a router
 * `<A>` are left alone on purpose: those are the app navigating, which is the point.
 */
export function openExternal(url: string): void {
	if (host().kind === "desktop") {
		// The shell has the OS; `window.open` in a `views://` webview at best does
		// nothing. A shell without the handler answers 404, and the fallback is what
		// the browser branch does, so an unwired shell behaves as it did before.
		void apiFetch("/api/native/open-external", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ url }),
		}).then(
			(response) => {
				if (!response.ok) window.open(url, "_blank", "noopener,noreferrer");
			},
			() => window.open(url, "_blank", "noopener,noreferrer"),
		);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Absolute http(s) *and* off-origin, so a router `<A>`, `#hash`, `/api/…` and
 * `mailto:` all keep their default. `href` is read back absolute by every engine,
 * so the scheme alone cannot tell "leave the app" from "the app navigating": a tab
 * on 5173 resolves its own `/settings` to http://localhost:5173/settings.
 */
function externalHref(node: Element | null): string | null {
	if (!(node instanceof HTMLAnchorElement)) return null;
	const href = node.href;
	if (!/^https?:/i.test(href)) return null;
	if (href.startsWith(`${window.location.origin}/`)) return null;
	return href;
}

/** The keys a web page answers to that an app should not: reload, print, save,
 * and the browser's own zoom. Only in the shell — in a tab, cmd+R is what the
 * user means, and taking it away from a developer is not an optimisation. */
function swallowedShortcut(event: KeyboardEvent): boolean {
	// In the shell on Windows/Linux the app owns ctrl; in a tab it owns it too, but
	// there cmd+R is what the user meant, and that branch never gets here anyway.
	const primary = event.metaKey || (event.ctrlKey && host().kind === "desktop" && host().platform !== "darwin");
	if (!primary || event.altKey) return false;
	const key = event.key.toLowerCase();
	// Zoom: cmd+0 restores, cmd+/- steps. The webview would otherwise rescale the
	// whole layout, and one accidental pinch leaves the sidebar half the screen.
	if (key === "0" || key === "=" || key === "+" || key === "-") return true;
	// Devtools are how the shell gets debugged, so they stay in a dev build.
	if ((key === "i" || key === "j") && import.meta.env.DEV) return false;
	return key === "r" || key === "p" || key === "s" || key === "i" || key === "j" || key === "u";
}

let installed = false;

/** Attach every rule. Returns the detach, so a test (or an HMR reload) can undo it. */
export function installAppBehavior(): () => void {
	if (installed) return () => undefined;
	installed = true;

	// -- context menu ------------------------------------------------------
	// The web menu (重新加载 / 另存为 / 打印 / 检查) is the single loudest tell.
	const onContextMenu = (event: MouseEvent) => {
		const target = element(event);
		if (target === null) return;
		// An input's own menu (cut/copy/paste/翻译) is worth its weight in a chat box.
		if (isEditable(target) || target.closest("[data-app-menu]") !== null) return;
		event.preventDefault();
	};

	// -- links -------------------------------------------------------------
	// Without this, one link inside a reply replaces the app — and in the shell,
	// where the page lives at `views://`, it replaces it with a blank window.
	const onClick = (event: MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0) return;
		const target = element(event);
		const href = externalHref(target?.closest("a") ?? null);
		if (href === null) return;
		event.preventDefault();
		openExternal(href);
	};

	// Middle-click on a link is a background-tab open in a browser; here it is
	// either nothing or a second window. Not the terminal's: middle-click paste.
	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 1 || insideTerminal(event.target)) return;
		const target = element(event);
		if (target === null || isEditable(target)) return;
		if (target.closest("a") === null) return;
		event.preventDefault();
	};

	// -- dragging ----------------------------------------------------------
	// Chrome is not draggable. Selected text inside real content still is, because
	// dragging a code fragment into another app is how people work.
	const onDragStart = (event: DragEvent) => {
		const target = element(event);
		if (target === null) return;
		if (target.closest("[data-app-drag]") !== null) return;
		if (target instanceof HTMLImageElement) {
			event.preventDefault();
			return;
		}
		const selection = document.getSelection();
		const draggingText = selection !== null && !selection.isCollapsed && selection.toString() !== "";
		if (draggingText && target.closest(SELECTABLE) !== null) return;
		if (insideTerminal(target) || isEditable(target)) return;
		event.preventDefault();
	};

	// Dropping a file anywhere else on the page makes the browser navigate to
	// `file:///…` and throw the session away. Swallow it; the composer and the
	// terminal handle their own drops and stop propagation before this.
	const onDragOver = (event: DragEvent) => {
		if (event.dataTransfer === null || !Array.from(event.dataTransfer.types).includes("Files")) return;
		event.preventDefault();
	};
	const onDrop = (event: DragEvent) => {
		if (!event.defaultPrevented) event.preventDefault();
	};

	// -- zoom --------------------------------------------------------------
	// The layout is designed for one scale; cmd+wheel must not reflow it. Plain
	// wheel is untouched, which is what keeps the terminal's scrollback alive.
	const onWheel = (event: WheelEvent) => {
		if (!event.ctrlKey && !event.metaKey) return;
		if (insideTerminal(event.target)) return;
		event.preventDefault();
	};

	// Only in the shell: a tab keeps its browser shortcuts.
	const shell = host().kind === "desktop";
	const onKeyDown = (event: KeyboardEvent) => {
		if (!shell || event.defaultPrevented || insideTerminal(event.target)) return;
		if (swallowedShortcut(event)) event.preventDefault();
	};

	document.addEventListener("contextmenu", onContextMenu);
	document.addEventListener("click", onClick);
	document.addEventListener("mousedown", onMouseDown);
	document.addEventListener("dragstart", onDragStart);
	document.addEventListener("dragover", onDragOver);
	document.addEventListener("drop", onDrop);
	// Not passive: a passive listener cannot cancel the wheel, which is the whole
	// reason this one exists.
	document.addEventListener("wheel", onWheel, { passive: false });
	document.addEventListener("keydown", onKeyDown);

	return () => {
		document.removeEventListener("contextmenu", onContextMenu);
		document.removeEventListener("click", onClick);
		document.removeEventListener("mousedown", onMouseDown);
		document.removeEventListener("dragstart", onDragStart);
		document.removeEventListener("dragover", onDragOver);
		document.removeEventListener("drop", onDrop);
		document.removeEventListener("wheel", onWheel);
		document.removeEventListener("keydown", onKeyDown);
		installed = false;
	};
}

/**
 * Freeze selection while a pointer drag resizes something. Without it, dragging
 * the sidebar divider paints the whole window blue, which looks like a bug in the
 * renderer rather than in the CSS. Components call this around their own drag.
 */
export function lockSelectionForDrag(): () => void {
	const previous = document.body.style.userSelect;
	document.body.style.userSelect = "none";
	return () => {
		document.body.style.userSelect = previous;
	};
}

/** Read the clipboard for a right-click paste, without a permission prompt on
 * every miss: `readText` fails when nothing is there or the page lost focus, and
 * a failed right-click is simply a right-click that did nothing. */
export async function clipboardText(): Promise<string> {
	try {
		return await navigator.clipboard.readText();
	} catch {
		return "";
	}
}
