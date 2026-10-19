/**
 * The event ring: the last N events a target sent, so a client that attaches late can still
 * see what just happened.
 *
 * State and events answer two different questions. State is "what is true now", and a client
 * that misses a frame is caught up by the next one. Events are "what happened", and there is
 * no next frame that carries them: a dev panel that connects mid-run would otherwise start
 * with a blank list and no idea whether the run is in its first turn or its fortieth.
 *
 * So every target keeps a small ring of its own events. A new subscriber gets the ring after
 * its snapshot — a bounded burst, once, which is exactly what "catch me up" means — and the
 * live events follow. The ring is also what makes a *filter* meaningful: a panel that only
 * wants `tool:*` asks for that and never receives the token stream at all, on the replay or
 * afterwards.
 *
 * Nothing here is durable. The ring is the last few hundred things that happened in this
 * process, and a restart legitimately starts with an empty one.
 */
import type { EventFrame } from "@eta/client-wire-proto";

/** How many events a target keeps. 512 is eta-agent's number, and it is a dev panel's. */
export const DEFAULT_RING_CAPACITY = 512;

export interface EventRing {
  /** Record an event; the oldest is forgotten when the ring is full. */
  push: (frame: EventFrame) => void;
  /** The ring, oldest first, optionally narrowed to events whose name contains `filter`. */
  tail: (filter?: string) => EventFrame[];
  /** How many events are held right now. */
  size: () => number;
}

export function createEventRing(capacity = DEFAULT_RING_CAPACITY): EventRing {
  /** A fixed-size window: `frames` always holds the ring in order, oldest first. */
  const frames: EventFrame[] = [];
  return {
    push(frame): void {
      frames.push(frame);
      if (frames.length > capacity) frames.splice(0, frames.length - capacity);
    },
    tail(filter): EventFrame[] {
      const needle = filter?.trim().toLowerCase();
      if (needle === undefined || needle.length === 0) return [...frames];
      // A name is `<family>:<what happened>` (`tool:start`, `turn:run-end`), so a substring
      // match is what a dev panel means by a filter — "tool" catches the family.
      return frames.filter((frame) =>
        frame.name.toLowerCase().includes(needle),
      );
    },
    size: () => frames.length,
  };
}

/** Whether an event name matches a subscription's filter. */
export function matchesFilter(
  name: string,
  filter: string | undefined,
): boolean {
  if (filter === undefined) return true;
  const needle = filter.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle);
}
