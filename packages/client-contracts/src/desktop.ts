/**
 * What the desktop app and the host promise each other.
 *
 * The two are released apart (`v*` and `desktop-v*` tags, `docs/release.md`), and the page a
 * window shows is the host's: a host upgraded from Settings brings a newer page into an older app,
 * and an app connected to a remote host shows whatever page that host has. So:
 *
 * - The app's bridge only grows. A capability, once shipped, keeps its name and its answer; a new
 *   one gets a new name. The app lists what it has (`capabilities` in `window.__ETA_HOST__`), and a
 *   page asks for a capability by name (`hasCapability` in `apps/web/src/lib/native.ts`), never by
 *   the app's version. An app from before the list has `BASELINE_CAPABILITIES`.
 * - When a host cannot work with an older app at all, it raises `MIN_DESKTOP` and the page tells
 *   the user to update the app. That is the only place a version is compared, and it should stay
 *   rare: a capability check is nearly always enough. Every release carries it in `eta-host.json`
 *   (`eta-host --version --json`), so the app can pick a host it can run without downloading one.
 */

/** The oldest desktop app this host's page works in. */
export const MIN_DESKTOP = "0.1.0";

/** What the bridge answered before the app listed its capabilities: the 0.1.0 app. */
export const BASELINE_CAPABILITIES = [
  "open-external",
  "save-file",
  "context-menu",
  "window-action",
  "connection",
] as const;

/**
 * A capability a page may ask the app for. New ones are added here and never renamed:
 * - `shell-update`: the app updates itself, by hand (`ShellUpdateView`). Only an app built with an
 *   update address has it.
 */
export type DesktopCapability =
  | (typeof BASELINE_CAPABILITIES)[number]
  | "shell-update";

/** Where the app's own update has got to. Nothing here happens unless the user asks. */
export type ShellUpdateState =
  | { state: "idle" }
  | { state: "checking" }
  /** Asked, and there is nothing newer. */
  | { state: "current" }
  | { state: "available"; version: string }
  /** `progress` is 0–100 when the server says the size. */
  | { state: "downloading"; version: string; progress?: number }
  /** Downloaded and checked; applying it restarts the app. */
  | { state: "ready"; version: string }
  | { state: "applying"; version: string }
  | { state: "failed"; during: "check" | "download" | "apply"; error: string };

/** The app's own version and update, as `GET /api/native/shell-update` answers. */
export type ShellUpdateView = ShellUpdateState & {
  /** This app's version. */
  current: string;
};

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i;

/**
 * `a` against `b` as semver orders them: negative, zero or positive. `undefined` when either is
 * not a version, such as `dev`.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (left === null || right === null) return undefined;
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  const [preLeft, preRight] = [left[4], right[4]];
  if (preLeft === preRight) return 0;
  // A pre-release comes before its release.
  if (preLeft === undefined) return 1;
  if (preRight === undefined) return -1;
  const partsLeft = preLeft.split(".");
  const partsRight = preRight.split(".");
  for (let index = 0; ; index++) {
    const [x, y] = [partsLeft[index], partsRight[index]];
    if (x === undefined || y === undefined)
      return partsLeft.length - partsRight.length;
    if (x === y) continue;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
}

/**
 * Whether an app of `appVersion` is older than `min`. An app that says no version, or one that is
 * not a release (`dev`), is not: it cannot be told apart, and a wrong warning is worse than none.
 */
export function desktopTooOld(
  appVersion: string | undefined,
  min: string = MIN_DESKTOP,
): boolean {
  if (appVersion === undefined) return false;
  const order = compareVersions(appVersion, min);
  return order !== undefined && order < 0;
}
