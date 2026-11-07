/**
 * The page inside the desktop shell, and nothing else.
 *
 * There is exactly one way to know where we are: the shell's preload puts `window.__ETA_HOST__`
 * on the page before any of its own code runs. A browser tab has no such object, so every function
 * here answers "not a shell" and does nothing — no attribute, no request, no throw. That is the
 * whole degradation story, and it is why callers may call unconditionally.
 *
 * Requests go to the window's own capability bridge on `nativeApiBase`, not to the host this page
 * came from and not over the wire. It is not product state: a window button belongs to one window,
 * so it lives in the process that owns that window, behind a token generated for that window only.
 *
 * What the shell tells us (`__ETA_HOST__`):
 *
 * - `apiBase` — the host. No page gets its token: a remote host trades it for a cookie, and a
 *   loopback host has no token gate.
 * - `connection`, `address` — whether that host is this computer's or a remote one, and where. A
 *   shell that cannot change it (an older one, or the dev page) says nothing.
 * - `native`, `nativeApiBase`, `nativeToken` — this window's capabilities.
 * - `platform`, `appVersion`, `role` — what the shell is and which page it meant to show.
 * - `error` — why it could not start the host. A page served by a host will not see this: with no
 *   host there is no page, and the shell shows its own.
 */

/** Which of the two places this page is open in. */
type HostKind = "desktop" | "browser";

type HostConnection = "local" | "remote";

export interface Host {
  kind: HostKind;
  /** `darwin`, `win32`, `linux` — only the shell can say. */
  platform: string | undefined;
  appVersion: string | undefined;
  /** `dev` while the shell runs the host out of a checkout; `desktop` from a packaged build. */
  role: string | undefined;
  /** Why the shell has no host running, when it has none. */
  error: string | undefined;
  /** Where the host is. Only a shell that can change it says. */
  connection: HostConnection | undefined;
  /** The remote host's origin. */
  address: string | undefined;
}

interface EtaHost {
  native?: unknown;
  nativeApiBase?: unknown;
  nativeToken?: unknown;
  platform?: unknown;
  appVersion?: unknown;
  role?: unknown;
  error?: unknown;
  connection?: unknown;
  address?: unknown;
}

declare global {
  interface Window {
    __ETA_HOST__?: EtaHost;
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const connectionOf = (value: unknown): HostConnection | undefined =>
  value === "local" || value === "remote" ? value : undefined;

/** Where this page is running, and what the shell said about itself. */
export function host(): Host {
  const injected = window.__ETA_HOST__;
  const shell =
    typeof injected === "object" &&
    injected !== null &&
    injected.native === true;
  return {
    kind: shell ? "desktop" : "browser",
    platform: shell ? text(injected.platform) : undefined,
    appVersion: shell ? text(injected.appVersion) : undefined,
    role: shell ? text(injected.role) : undefined,
    error: shell ? text(injected.error) : undefined,
    connection: shell ? connectionOf(injected.connection) : undefined,
    address: shell ? text(injected.address) : undefined,
  };
}

/**
 * Say on `<html>` that this is the shell — the window's chrome depends on it (`data-host`), and
 * the browser must not have the attribute at all rather than have it be false.
 */
export function markHost(): Host {
  const where = host();
  if (where.kind === "desktop")
    document.documentElement.dataset.host = "desktop";
  return where;
}

/** This window's capability bridge, or nothing when there is no shell around the page. */
function bridge(): { apiBase: string; token: string } | undefined {
  const injected: EtaHost | undefined = window.__ETA_HOST__;
  if (injected?.native !== true) return undefined;
  const apiBase = text(injected.nativeApiBase);
  const token = text(injected.nativeToken);
  return apiBase === undefined || token === undefined
    ? undefined
    : { apiBase, token };
}

/**
 * One call to the window. A `null` answer means the shell could not do it — or was never asked,
 * because this is a browser — and the caller should behave as if the capability is missing.
 */
async function call<T>(
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<T | null> {
  const target = bridge();
  if (target === undefined) return null;
  const response = await fetch(`${target.apiBase}/api/native/${path}`, {
    method: body === undefined ? "GET" : "POST",
    // Never in a cache, and never carrying a cookie: this port answers this page and this launch.
    cache: "no-store",
    credentials: "omit",
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => null);
  if (response?.ok !== true) return null;
  return (await response.json().catch(() => null)) as T | null;
}

/**
 * Hand a link to the system browser. A window has no tab strip, so a new-window link there either
 * does nothing or opens a bare window with no shell around it: the same page, minus everything
 * that makes it eta.
 */
export async function openExternal(url: string): Promise<void> {
  await call("open-external", { url });
}

/**
 * The window buttons a page has to draw, and the way it asks the window to act.
 *
 * A macOS window keeps its own three lights, inset into our band; a Windows window whose title bar
 * was hidden (`titleBarStyle: "hidden"`) has no caption buttons at all, so the page paints them
 * (`components/window-controls.tsx`) — and a painted button can only close a window by asking the
 * process that owns it. That one capability is `window-action` on the bridge above.
 */
export type WindowAction =
  | "close"
  | "minimize"
  | "toggle-maximize"
  | "connection";

/**
 * Whether the three buttons are ours to draw.
 *
 * Windows, because the frame it hides them with is the one that draws them. macOS keeps its own
 * lights, and a browser has no window to close — both answer no, and the buttons do not exist
 * there rather than existing and doing nothing.
 */
export function drawsOwnWindowControls(): boolean {
  return host().platform === "win32";
}

/**
 * Ask the window to close, minimise or toggle its maximised state.
 *
 * Fire and forget: the answer is the window doing the thing, not a response body. Without a bridge
 * to ask (a browser, or a shell that failed to start) this is nothing at all, which is the correct
 * amount of window closing a web page can do.
 */
export async function windowAction(action: WindowAction): Promise<void> {
  await call("window-action", { action });
}

/**
 * Ask the shell for its connection page. The page itself is the shell's, in the language this one
 * is in, and a remote page hears nothing more about the connection than it already has.
 */
export async function openConnectionPage(language: string): Promise<void> {
  await call("window-action", { action: "connection", language });
}

/** Links that mean "somewhere else": a new window, or another origin. Same-page links stay here. */
function leavesTheApp(anchor: HTMLAnchorElement): boolean {
  if (anchor.target === "_blank") return true;
  try {
    const url = new URL(anchor.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * In the shell, links that leave the app go to the system browser instead of leaving the app.
 *
 * One listener on the document rather than a change in every component that renders a link: the
 * shell must not navigate away, and that is true of every `target="_blank"` the product will ever
 * render, including ones written after this. In a browser this installs nothing at all — the tab
 * already does the right thing, and its behaviour must stay untouched.
 *
 * Returns the way to stop watching, because a listener on the document outlives whatever asked for
 * it (the tests make a new page per case).
 */
export function watchExternalLinks(): () => void {
  if (host().kind !== "desktop") return () => {};
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement) || !leavesTheApp(anchor)) return;
    event.preventDefault();
    void openExternal(anchor.href);
  };
  // Capture: a link inside something that handles its own clicks still gets here first.
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
