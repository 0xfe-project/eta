// What the phone remembers between creations, as the web's workspace store does per browser.

import { signal, Storage } from "nsh";

const RECENT_KEY = "eta.recentDirectories";
const MODEL_KEY = "eta.lastModel";
/** How many chosen directories each machine remembers. */
const RECENT_DIRECTORIES = 5;

/** Machine id → the directories chosen on it, newest first. */
export const recentDirectories = signal<Record<string, string[]>>({});
/** Undefined until storage answered; null when nothing was stored. */
export const lastModel = signal<string | null | undefined>(undefined);

let loading: Promise<void> | undefined;

export function loadRemembered(): Promise<void> {
  loading ??= (async () => {
    const [recent, model] = await Promise.all([
      Storage.getItem(RECENT_KEY),
      Storage.getItem(MODEL_KEY),
    ]);
    if (recent) {
      try {
        recentDirectories.set(JSON.parse(recent) as Record<string, string[]>);
      } catch {
        // Not ours to fix: it is overwritten by the next directory chosen.
      }
    }
    lastModel.set(model ?? null);
  })();
  return loading;
}

export function rememberDirectory(machineId: string, path: string): void {
  const earlier = recentDirectories()[machineId] ?? [];
  const next = {
    ...recentDirectories(),
    [machineId]: [path, ...earlier.filter((seen) => seen !== path)].slice(0, RECENT_DIRECTORIES),
  };
  recentDirectories.set(next);
  void Storage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function rememberModel(model: string): void {
  lastModel.set(model);
  void Storage.setItem(MODEL_KEY, model);
}
