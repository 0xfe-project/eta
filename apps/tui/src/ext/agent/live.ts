import type { WireClient } from "../../connection/types";

const DEFAULT_WAIT_MS = 10_000;

/**
 * A target's sections as the host has them now, for code outside React. Subscribes to the
 * target, waits until the held copy is one that follows the host (version above 0, see
 * `TargetState.version`) and `ready` holds, and releases the subscription either way. Rejects with
 * `failure` when that does not happen within the wait, or the host has no such target.
 */
export async function readLive(
  wire: WireClient,
  target: string,
  options: {
    ready: (sections: Record<string, unknown>) => boolean;
    failure: string;
    timeoutMs?: number;
  },
): Promise<Record<string, unknown>> {
  const release = wire.subscribe(target);
  try {
    return await new Promise((resolve, reject) => {
      let stopWatching = () => {};
      const timer = setTimeout(() => {
        stopWatching();
        reject(new Error(options.failure));
      }, options.timeoutMs ?? DEFAULT_WAIT_MS);
      const check = () => {
        const state = wire.store.getState();
        const held = state.targets[target];
        const missing = state.missing[target] === true;
        if (!missing && (held === undefined || held.version === 0)) return;
        if (!missing && !options.ready(held!.sections)) return;
        clearTimeout(timer);
        stopWatching();
        if (missing) reject(new Error(options.failure));
        else resolve(held!.sections);
      };
      stopWatching = wire.store.subscribe(check);
      check();
    });
  } finally {
    release();
  }
}
