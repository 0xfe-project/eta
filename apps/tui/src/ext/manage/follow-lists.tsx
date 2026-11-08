import { useEffect } from "react";
import { useShell } from "../../extensions/react";

/** The eager lists the commands read when they run. */
const FOLLOWED = ["agents", "projects"];

/**
 * Follows the eager agent and project lists while the shell shows: the host sends them with hello
 * and pushes changes only to a subscriber, and the commands read them when they run (names to
 * match, the project a path given to `/new` already is).
 */
export function FollowLists() {
  const { wire } = useShell();
  useEffect(() => {
    const releases = FOLLOWED.map((target) => wire.subscribe(target));
    return () => {
      for (const release of releases) release();
    };
  }, [wire]);
  return null;
}
