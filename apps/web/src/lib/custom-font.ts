/**
 * The interface font a person chose in Settings → Appearance, put in front of the shipped one.
 *
 * The app ships one face, Eta Sans, and a custom font only goes ahead of it: `--font-sans`
 * becomes `"<name>", <the default stack>`, so a glyph the chosen font lacks (or a font this
 * machine does not have) falls back to Eta Sans and then the system's. A mono font goes ahead of
 * that in `--font-mono`; without one, mono follows the interface font. Empty means the default,
 * with nothing set on the document.
 *
 * A name is checked against an allowlist rather than escaped: letters and digits in any script,
 * spaces, `-`, `_` and `.`, one family, at most 64 characters. Nothing that could end a string or
 * a declaration (`"`, `'`, `\`, `;`, `(`, `)`, `{`, `}`, `,`, `:`, `/`, `<`, `>`) gets through, so
 * `url(…)` or a second declaration cannot be written into the value — and `setProperty` takes one
 * value either way.
 */

import { useWorkspaceStore } from "@/components/workspace/workspace-store";

/** The shipped stack, as in styles.css: what a custom font falls back to. */
export const defaultFontStack =
  '"Eta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif';

export const customFontMaxLength = 64;

const allowed = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]*$/u;

/**
 * A typed name as it will be stored: trimmed, inner runs of spaces folded to one. `""` means the
 * default; `null` means the name is not one this setting accepts.
 */
export function normalizeCustomFont(input: string): string | null {
  const name = input.trim().replace(/\s+/g, " ");
  if (name === "") return "";
  if (name.length > customFontMaxLength) return null;
  return allowed.test(name) ? name : null;
}

/** The value `--font-sans` takes for a stored name: that face, then the shipped stack. */
export function customFontStack(name: string): string {
  return `"${name}", ${defaultFontStack}`;
}

/** The two names as stored; either may be absent. */
export interface CustomFonts {
  /** The interface font: `--font-sans`, and `--font-mono` too when no mono font is set. */
  sans?: string | undefined;
  /** The font for the "mono" surfaces (times, code, chips): `--font-mono` only. */
  mono?: string | undefined;
}

/** A stored name that passes the check, or undefined (unset, empty, or edited by hand). */
function valid(stored: string | undefined): string | undefined {
  if (stored === undefined) return undefined;
  return normalizeCustomFont(stored) || undefined;
}

/**
 * Puts the fonts on the document, or takes them off for the default. The mono font goes in front
 * of whatever the interface is drawn in, so a glyph it lacks comes from the interface font, then
 * Eta Sans, then the system; with no mono font the mono surfaces follow the interface font, as
 * they always have.
 */
export function applyCustomFont({ sans, mono }: CustomFonts): void {
  const root = document.documentElement;
  const sansName = valid(sans);
  const monoName = valid(mono);
  const sansStack =
    sansName === undefined ? undefined : customFontStack(sansName);
  const monoStack =
    monoName === undefined
      ? sansStack
      : `"${monoName}", ${sansStack ?? defaultFontStack}`;
  set(root, "--font-sans", sansStack);
  set(root, "--font-mono", monoStack);
  // Read by devtools and diagnostics: says which faces this window is drawn in.
  setData(root, "customFont", sansName);
  setData(root, "customMonoFont", monoName);
}

function set(root: HTMLElement, name: string, value: string | undefined) {
  if (value === undefined) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

function setData(root: HTMLElement, key: string, value: string | undefined) {
  if (value === undefined) delete root.dataset[key];
  else root.dataset[key] = value;
}

const saved = (): CustomFonts => {
  const { customFont, customMonoFont } = useWorkspaceStore.getState().workspace;
  return { sans: customFont, mono: customMonoFont };
};

/** Applies the saved fonts now and again whenever either setting changes; returns the unsubscribe. */
export function watchCustomFont(): () => void {
  applyCustomFont(saved());
  return useWorkspaceStore.subscribe((state, previous) => {
    if (
      state.workspace.customFont !== previous.workspace.customFont ||
      state.workspace.customMonoFont !== previous.workspace.customMonoFont
    )
      applyCustomFont(saved());
  });
}
