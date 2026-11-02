/**
 * The color mode, in one small place.
 *
 * This used to be `next-themes`, which is built for servers that render HTML: it puts a
 * `<script>` into the React tree so the class is on `<html>` before the first paint. This app
 * is a single page — React creates that element on the client, where a script inside a
 * component never runs. The result was not an error anyone saw, it was a white flash for
 * everyone in dark mode, on every load.
 *
 * So: the same three things, split where they belong. `index.html` carries the inline script
 * that paints before the bundle loads (a real script in real HTML, which does run), and this
 * module is what React reads and writes afterwards. Same storage key as before, so a choice
 * already made in this browser is still the choice.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Where the choice is kept. Also read by the inline script in index.html. */
const THEME_STORAGE_KEY = "theme";

const listeners = new Set<() => void>();
const darkQuery = () =>
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : undefined;

export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  } catch {
    // Private mode, or storage denied: follow the system, which needs no storage.
    return "system";
  }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  return darkQuery()?.matches === true ? "dark" : "light";
}

/** Put the resolved mode on the document. The only place the DOM is touched. */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  if (typeof document === "undefined") return resolved;
  const root = document.documentElement;
  // Every color transition would fire at once and the switch would smear: flip in one frame.
  const still = document.createElement("style");
  still.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.append(still);
  root.classList.toggle("dark", resolved === "dark");
  // Form controls, scrollbars and the canvas behind the page follow this, not the class.
  root.style.colorScheme = resolved;
  // Commit the new colors while transitions are off, then hand them back after the paint.
  void root.offsetHeight;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(() => still.remove()));
  } else {
    still.remove();
  }
  return resolved;
}

export function setTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not persisted; the choice still applies for this visit.
  }
  applyTheme(choice);
  for (const listener of listeners) listener();
}

/** Follow the system while the choice is `system`: switching it is a visible change. */
export function watchSystemTheme(): () => void {
  const query = darkQuery();
  if (query === undefined) return () => {};
  const onChange = () => {
    if (readTheme() !== "system") return;
    applyTheme("system");
    for (const listener of listeners) listener();
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * The hook the app uses. A snapshot of the choice plus the resolved mode, so a component that
 * needs "am I dark right now" (toasts) does not have to resolve `system` itself.
 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
