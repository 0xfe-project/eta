import { signal, Storage } from "nsh";
import { sizes } from "../components/theme";

/**
 * The widths the reader dragged the desktop sidebar and conversation panel to, kept on this device.
 * Range and keys follow the web app (`apps/web/src/lib/pane.ts`), so one habit holds on both;
 * the defaults are the fixed widths the panes had before they could be dragged.
 */
export type Pane = "sidebar" | "panel";

export const paneLimits = {
  sidebar: { min: 260, max: 420, fallback: sizes.sidebar },
  panel: { min: 320, max: 720, fallback: sizes.panel },
} as const;

const keys: Record<Pane, string> = {
  sidebar: "eta.sidebar.width",
  panel: "eta.panel.width",
};

/** `width` rounded and held to the pane's range; a value that is not a number is the default. */
export function clampPaneWidth(pane: Pane, width: number): number {
  const { min, max, fallback } = paneLimits[pane];
  if (!Number.isFinite(width)) return fallback;
  return Math.min(max, Math.max(min, Math.round(width)));
}

/** The width a stored string holds, or `undefined` when it holds none. */
export function parsePaneWidth(
  pane: Pane,
  raw: string | null | undefined,
): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? clampPaneWidth(pane, value) : undefined;
}

/**
 * The width after a drag of `delta` points from `start`. The sidebar's handle is on its right
 * edge, so dragging right widens it; the panel's is on its left edge, so dragging left does.
 */
export function draggedPaneWidth(pane: Pane, start: number, delta: number) {
  return clampPaneWidth(pane, pane === "sidebar" ? start + delta : start - delta);
}

const widths = {
  sidebar: signal<number>(paneLimits.sidebar.fallback),
  panel: signal<number>(paneLimits.panel.fallback),
};
const touched = { sidebar: false, panel: false };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  for (const pane of ["sidebar", "panel"] as const)
    void Storage.getItem(keys[pane])
      .then((raw) => {
        const stored = parsePaneWidth(pane, raw);
        // A drag made before storage answered is newer than what it held.
        if (stored !== undefined && !touched[pane]) widths[pane].set(stored);
      })
      .catch(() => {});
}

/** The pane's width now: the reader's, else the default. */
export function paneWidth(pane: Pane): number {
  load();
  return widths[pane]();
}

/** Follow a drag: the width changes on screen, nothing is saved until `savePaneWidth`. */
export function setPaneWidth(pane: Pane, width: number): void {
  load();
  touched[pane] = true;
  widths[pane].set(clampPaneWidth(pane, width));
}

/** Remember where the reader left the pane. */
export function savePaneWidth(pane: Pane): void {
  void Storage.setItem(keys[pane], String(widths[pane]())).catch(() => {});
}
