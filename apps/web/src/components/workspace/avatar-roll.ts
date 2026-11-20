import { useEffect, useRef, useState } from "react";

/** Faces the large avatar passes over before it lands. */
const FLICKS = 3;
/** How long each passing face shows; `avatar-flick` runs this long. */
const FLICK_MS = 60;
/** How long the landed face settles; `avatar-settle` runs this long. */
const SETTLE_MS = 160;

/** The one source of faces: passing and landed alike. */
const drawSeed = () => crypto.randomUUID().slice(0, 8);

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A draw that passes over a few faces before it lands on one. `face` is the face passing now, null
 * outside the passing frames; `rolling` holds from the click until the landed face has settled,
 * and a `roll` meanwhile does nothing. Only the landed face reaches `onSettle`, once per roll. With
 * reduced motion there are no passing frames: the face lands at once.
 */
export function useAvatarRoll({
  onSettle,
}: {
  onSettle: (seed: string) => void;
}) {
  const [face, setFace] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const settleRef = useRef(onSettle);
  useEffect(() => {
    settleRef.current = onSettle;
  });
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const roll = () => {
    if (rolling) return;
    if (reducedMotion()) {
      settleRef.current(drawSeed());
      return;
    }
    setRolling(true);
    setFace(drawSeed());
    const at = (ms: number, step: () => void) =>
      timersRef.current.push(setTimeout(step, ms));
    for (let flick = 1; flick < FLICKS; flick++)
      at(flick * FLICK_MS, () => setFace(drawSeed()));
    at(FLICKS * FLICK_MS, () => {
      setFace(null);
      settleRef.current(drawSeed());
    });
    at(FLICKS * FLICK_MS + SETTLE_MS, () => {
      timersRef.current = [];
      setRolling(false);
    });
  };

  return { face, rolling, roll };
}
