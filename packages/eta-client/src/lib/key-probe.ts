/**
 * A dev-only readout of what the page is actually being handed.
 *
 * Three different failures look identical from the outside — AppKit eating a key
 * equivalent before the webview sees it, WKWebView delivering a keydown with flags
 * no one documented, and the composer deciding the key belongs to an IME — and the
 * only difference between them is what the event carried. Guessing at that is how
 * ⌘↵ was "still not working" three times in a row.
 *
 * Dev builds inside the shell only (plus `?keys` in a tab), because it is a strip of
 * debugging chrome and it should not be visible where nobody can open a console to
 * interpret it. It draws itself with plain DOM: it has to survive whatever the page
 * is doing, and it is not part of any component's state.
 */

interface Row {
	/** What happened, as the page saw it. */
	line: string;
	/** Whether the page was allowed to act on it. */
	cancelled: boolean;
}

const MAX_ROWS = 6;
const rows: Row[] = [];

let panel: HTMLElement | undefined;

function flags(event: KeyboardEvent): string {
	const modifiers = `${event.metaKey ? "⌘" : ""}${event.ctrlKey ? "⌃" : ""}${event.altKey ? "⌥" : ""}${event.shiftKey ? "⇧" : ""}`;
	const target = event.target instanceof Element ? (event.target.tagName.toLowerCase() + (event.target.id !== "" ? `#${event.target.id}` : "")) : "?";
	return `${event.key} ${modifiers.length > 0 ? modifiers : "—"} → ${target} comp=${event.isComposing} kc=${event.keyCode}`;
}

function render(): void {
	if (panel === undefined) return;
	panel.textContent = "";
	for (const row of rows) {
		const line = document.createElement("div");
		line.textContent = `${row.cancelled ? "⊘" : "·"} ${row.line}`;
		panel.append(line);
	}
}

function push(line: string, cancelled: boolean): void {
	rows.unshift({ line, cancelled });
	if (rows.length > MAX_ROWS) rows.pop();
	render();
}

let compositionEndedAt = 0;

/** Attach the readout. Returns the detach, and does nothing at all when this is not
 * an environment that asked for it. */
export function installKeyProbe(): () => void {
	const armed = typeof window !== "undefined"
		&& import.meta.env.DEV
		&& (new URLSearchParams(window.location.search).has("keys") || window.__ETA_HOST__?.kind === "desktop");
	if (!armed) return () => undefined;

	const onKeyDown = (event: KeyboardEvent) => {
		const since = compositionEndedAt === 0 ? "—" : `${Math.round(performance.now() - compositionEndedAt)}ms后`;
		push(`${flags(event)}${event.key === "Enter" ? ` [合成结束于 ${since}]` : ""}`, event.defaultPrevented);
	};
	const onComposition = (event: Event) => {
		compositionEndedAt = event.type === "compositionend" ? performance.now() : compositionEndedAt;
		push(`composition${event.type === "compositionend" ? "end" : "start"} "${(event as CompositionEvent).data ?? ""}"`, false);
	};

	panel = document.createElement("div");
	panel.dataset.testid = "key-probe";
	panel.style.cssText = [
		"position:fixed", "right:8px", "bottom:8px", "z-index:9999",
		"max-width:46vw", "padding:4px 6px",
		"border:1px dashed rgba(128,128,128,0.7)", "background:rgba(0,0,0,0.75)", "color:#9fdf9f",
		"font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace", "white-space:nowrap",
		"overflow:hidden", "text-overflow:ellipsis", "pointer-events:none",
	].join(";");
	document.body.append(panel);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("compositionstart", onComposition, true);
	document.addEventListener("compositionend", onComposition, true);
	push(`探针就位 — 按键会被记录（⊘ = 已被 preventDefault）`, false);

	window.__etaKeys = () => rows.map((row) => `${row.cancelled ? "⊘" : "·"} ${row.line}`);
	return () => {
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("compositionstart", onComposition, true);
		document.removeEventListener("compositionend", onComposition, true);
		panel?.remove();
		panel = undefined;
	};
}

declare global {
	interface Window {
		/** The probe's own ring buffer, for a console: most recent first. */
		__etaKeys?: () => string[];
	}
}
