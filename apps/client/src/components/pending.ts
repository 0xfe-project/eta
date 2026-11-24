import { cleanup, effect, signal, untracked } from "nsh";
import { motion } from "./motion";

// Waiting, shown only when it is worth showing (#380): a wait shorter than `motion.reveal` shows
// nothing, and what appeared stays `motion.minShown`, so a spinner or a skeleton never flashes.

/**
 * Whether a wait should be on screen: true once `busy` has held for `motion.reveal`, and from then
 * on at least `motion.minShown`, even if `busy` ended sooner.
 */
export function shownWhile(busy: () => boolean): () => boolean {
  const shown = signal(false);
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const waiting = busy();
    clearTimeout(timer);
    timer = undefined;
    untracked(() => {
      if (waiting) {
        if (shown()) return;
        timer = setTimeout(() => {
          since = Date.now();
          shown.set(true);
        }, motion.reveal);
        return;
      }
      if (!shown()) return;
      const left = motion.minShown - (Date.now() - since);
      if (left <= 0) shown.set(false);
      else timer = setTimeout(() => shown.set(false), left);
    });
  });
  cleanup(() => clearTimeout(timer));
  return shown;
}

/**
 * Whether what a region waits for may be drawn: `ready`, and the skeleton that stood in for it
 * (if one appeared) has had its `motion.minShown`. Until then the region keeps its skeleton,
 * which draws itself only after `motion.reveal` (loading-skeleton.tsx).
 */
export function settled(ready: () => boolean): () => boolean {
  const waiting = shownWhile(() => !ready());
  return () => ready() && !waiting();
}
