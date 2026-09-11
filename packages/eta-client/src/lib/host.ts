/**
 * The client runs in three hosts: a browser tab, an Electrobun webview, and a
 * phone browser over LAN. Everything network-shaped is built here so a page
 * whose origin is `views://eta` or the Vite dev server can still reach the
 * server that owns the sessions.
 *
 * The desktop shell injects `window.__ETA_HOST__` before any of our scripts
 * run; without it this is a relative-path client and behaves exactly as it did
 * before the desktop existed. Nothing in this file imports electrobun — the
 * browser bundle and the webview bundle are the same bytes, which is the whole
 * point of routing through here instead of monkey-patching `globalThis.fetch`.
 */

export interface EtaHost {
	kind: "browser" | "desktop";
	/** "" in a browser tab (same origin), `http://127.0.0.1:<port>` in the webview. */
	apiBase: string;
	/** `ws://host` — no path. */
	wsBase: string;
	/** Set by the desktop shell; the server rejects requests without it there. */
	token?: string;
	platform?: string;
	appVersion?: string;
}

declare global {
	interface Window {
		__ETA_HOST__?: Partial<EtaHost>;
	}
}

const FALLBACK_AUTHORITY = "127.0.0.1:5173";

function browserAuthority(): string {
	if (typeof window === "undefined") return FALLBACK_AUTHORITY;
	const secure = window.location.protocol === "https:";
	return `${secure ? "wss" : "ws"}://${window.location.host}`;
}

function wsOriginOf(apiBase: string): string {
	return apiBase.replace(/^http/, "ws");
}

function resolveHost(injected: Partial<EtaHost> | undefined): EtaHost {
	if (injected?.apiBase === undefined || !/^https?:\/\//.test(injected.apiBase)) return { kind: "browser", apiBase: "", wsBase: browserAuthority() };
	const apiBase = injected.apiBase.replace(/\/$/, "");
	return {
		kind: "desktop",
		apiBase,
		wsBase: injected.wsBase ?? wsOriginOf(apiBase),
		...(injected.token === undefined ? {} : { token: injected.token }),
		...(injected.platform === undefined ? {} : { platform: injected.platform }),
		...(injected.appVersion === undefined ? {} : { appVersion: injected.appVersion }),
	};
}

let resolved: EtaHost | undefined;

/**
 * The host this page is running in. Decided on first use rather than at import:
 * the shell's preload runs before any of our code, so in production the answer
 * cannot move under us either way, but a page module imported during a test sees
 * the module graph loaded long before the test can describe its host — and the
 * same page then looked like two different hosts depending on which spec ran
 * first. Asking once, late, is the same answer with that trap removed.
 */
export function host(): EtaHost {
	if (resolved === undefined) resolved = resolveHost(typeof window === "undefined" ? undefined : window.__ETA_HOST__);
	return resolved;
}

export function apiUrl(path: string): string {
	if (/^[a-z][a-z\d+\-.]*:/i.test(path)) return path;
	return `${host().apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export function wsUrl(path: string): string {
	if (/^wss?:\/\//i.test(path)) return path;
	return `${host().wsBase}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The one fetch every `/api` call goes through. A tab has no token and is left
 * exactly the call it would have made before the desktop existed; the webview
 * adds the token as a header, so FormData uploads still let the browser set
 * `content-type` and its boundary.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const url = apiUrl(path);
	const { token } = host();
	if (token === undefined) return Object.keys(init).length === 0 ? fetch(url) : fetch(url, init);
	const headers = new Headers(init.headers);
	if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
	return fetch(url, { ...init, headers });
}

/** The token for endpoints a `<script>`/`<img>`/WebSocket must carry in the URL. */
export function withToken(path: string): string {
	const { token } = host();
	if (token === undefined) return path;
	return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * An app route, from code with no router handle in reach: a palette command, a
 * callback handed to a button. Where the router is mounted, `useNavigate()` is
 * the better call; this is for the rest. The shell routes by hash — the page is
 * loaded from `views://eta/index.html`, so `location.assign("/new")` there asks
 * the shell for a file that is not in the bundle and the window comes back blank.
 */
export function goto(path: string): void {
	if (host().kind === "desktop") window.location.hash = `#${path}`;
	else window.location.assign(path);
}
