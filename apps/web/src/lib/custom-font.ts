/**
 * The interface font a person chose in Settings → Appearance, put in front of the shipped one.
 *
 * The app ships one face, Eta Sans, and a custom font only goes ahead of it: `--font-sans` and
 * `--font-mono` become `"<name>", <the default stack>`, so a glyph the chosen font lacks (or a
 * font this machine does not have) falls back to Eta Sans and then the system's. Empty means
 * the default, with nothing set on the document.
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

/** The value `--font-sans` and `--font-mono` take for a stored name. */
export function customFontStack(name: string): string {
  return `"${name}", ${defaultFontStack}`;
}

/**
 * Puts the font on the document, or takes it off for the default. A stored value that does not
 * pass the check (edited by hand in storage) is treated as unset.
 */
export function applyCustomFont(stored: string | undefined): void {
  const root = document.documentElement;
  const name = stored === undefined ? "" : normalizeCustomFont(stored);
  if (name === null || name === "") {
    root.style.removeProperty("--font-sans");
    root.style.removeProperty("--font-mono");
    // Read by bug reports and screenshots: says which face this window is drawn in.
    delete root.dataset.customFont;
    return;
  }
  const stack = customFontStack(name);
  root.style.setProperty("--font-sans", stack);
  root.style.setProperty("--font-mono", stack);
  root.dataset.customFont = name;
}

/** Applies the saved font now and again whenever the setting changes; returns the unsubscribe. */
export function watchCustomFont(): () => void {
  applyCustomFont(useWorkspaceStore.getState().workspace.customFont);
  return useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspace.customFont !== previous.workspace.customFont)
      applyCustomFont(state.workspace.customFont);
  });
}
