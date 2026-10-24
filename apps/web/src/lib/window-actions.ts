/**
 * The window buttons the page has to draw, and the way it asks the window to act.
 *
 * On macOS the window keeps its own three lights; on Windows a frameless window has none, so the
 * page paints them (`components/window-controls.tsx`) — and a painted button can only close a
 * window by asking the process that owns it. The shell serves that one capability on a loopback
 * bridge of its own (see `apps/desktop/src/bun/native.ts`), and the facts needed to reach it —
 * `platform`, `nativeApiBase`, `nativeToken` — are injected by the shell's preload as
 * `window.__ETA_HOST__`.
 *
 * The facts are read defensively rather than declared as a global type: in a browser nobody wrote
 * `__ETA_HOST__`, and this module has to answer "is this a Windows shell" with a plain no instead
 * of throwing during the first render.
 */

export type WindowAction = "close" | "minimize" | "toggle-maximize";

/** The part of the injected shell facts this module reads. */
interface ShellFacts {
  nativeApiBase?: unknown;
  nativeToken?: unknown;
  platform?: unknown;
}

function shell(): ShellFacts | undefined {
  const injected: unknown = (globalThis as { __ETA_HOST__?: unknown })
    .__ETA_HOST__;
  return typeof injected === "object" && injected !== null
    ? (injected as ShellFacts)
    : undefined;
}

/** The shell's platform (`darwin`, `win32`, …), or `undefined` in a browser. */
function shellPlatform(): string | undefined {
  const platform = shell()?.platform;
  return typeof platform === "string" ? platform : undefined;
}

/**
 * Whether the three buttons are ours to draw.
 *
 * Windows, because the frame it hides them with is the one that draws them. macOS keeps its own
 * lights inset into our band, and a browser has no window to close — both answer no, and the
 * buttons do not exist there rather than existing and doing nothing.
 */
export function drawsOwnWindowControls(): boolean {
  return shellPlatform() === "win32";
}

/**
 * Ask the window to close, minimise or toggle its maximised state.
 *
 * Fire and forget: the answer is the window doing the thing, not a response body. Without a
 * bridge to ask (a browser, or a shell that failed to start) this is nothing at all, which is the
 * correct amount of window closing a web page can do.
 */
export async function windowAction(action: WindowAction): Promise<void> {
  const facts = shell();
  const base = facts?.nativeApiBase;
  const token = facts?.nativeToken;
  if (typeof base !== "string" || base === "" || typeof token !== "string")
    return;
  await fetch(`${base}/api/native/window-action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ action }),
  }).catch(() => undefined);
}
