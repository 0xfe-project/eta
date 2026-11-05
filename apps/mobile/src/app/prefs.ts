import { setColorScheme, signal, Storage } from "nsh";

const SCHEME_KEY = "eta.scheme";

export type Scheme = "system" | "light" | "dark";
export const scheme = signal<Scheme>("system");

export function setScheme(next: Scheme): void {
  scheme.set(next);
  setColorScheme(next);
  void Storage.setItem(SCHEME_KEY, next);
}

export async function loadScheme(): Promise<void> {
  const stored = await Storage.getItem(SCHEME_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    scheme.set(stored);
    setColorScheme(stored);
  }
}
