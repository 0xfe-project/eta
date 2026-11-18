// What the phone remembers between creations. The directories used lately are the host's now
// (`places.recent`, shared with the web and the terminal); what the phone kept before is handed
// over once (`importRecentDirectories`).

import { signal, Storage } from "nsh";
import { call } from "../../wire/target";

/** Where the phone kept its recent directories before the host did: machine id → paths. */
const RECENT_KEY = "eta.recentDirectories";
const MODEL_KEY = "eta.lastModel";

/** Undefined until storage answered; null when nothing was stored. */
export const lastModel = signal<string | null | undefined>(undefined);

let loading: Promise<void> | undefined;

export function loadRemembered(): Promise<void> {
  loading ??= (async () => {
    lastModel.set((await Storage.getItem(MODEL_KEY)) ?? null);
  })();
  return loading;
}

export function rememberModel(model: string): void {
  lastModel.set(model);
  void Storage.setItem(MODEL_KEY, model);
}

let importing: Promise<void> | undefined;

/**
 * The recent directories this phone kept, handed to the host once and then let go of. The host
 * adds what it does not know behind what it does, so asking twice changes nothing; only its answer
 * removes them here, so a failed try is tried again the next time.
 */
export function importRecentDirectories(): Promise<void> {
  importing ??= (async () => {
    const stored = await Storage.getItem(RECENT_KEY);
    if (stored === null || stored === undefined) return;
    let recent: unknown;
    try {
      recent = JSON.parse(stored);
    } catch {
      // Nothing the host could take: let it go.
      await Storage.removeItem(RECENT_KEY);
      return;
    }
    try {
      await call("places", "importRecent", { recent });
      await Storage.removeItem(RECENT_KEY);
    } catch {
      importing = undefined;
    }
  })();
  return importing;
}
