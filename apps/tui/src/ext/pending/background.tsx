import { useEffect } from "react";
import { useAction, useShell } from "../../extensions/react";
import { openReview } from "./open";

/** The targets everything here reads; the host pushes their changes only to a subscriber. */
const FOLLOWED = ["inbox", "tasks", "agents"] as const;

/** Follows what waits while the shell shows, and opens review mode on its key. */
export function PendingBackground() {
  const ctx = useShell();
  const { wire } = ctx;
  useEffect(() => {
    const releases = FOLLOWED.map((target) => wire.subscribe(target));
    return () => {
      for (const release of releases) release();
    };
  }, [wire]);
  useAction("review.open", () => openReview(ctx));
  return null;
}
