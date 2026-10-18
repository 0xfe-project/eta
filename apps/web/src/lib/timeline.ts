import type { MessageStatus, MessageView } from "@eta/client-contracts";

// A conversation's timeline, as rows the page has seen: the newest window the host publishes,
// older pages fetched on demand, and what our own `send` and `stop` calls answered with. A row
// changes in place (a reply goes queued -> working -> done), and `revision` is what tells a newer
// copy from an older one.

/** A reply that has not ended: someone is, or is about to be, answering. */
export const ACTIVE_STATUSES: ReadonlySet<MessageStatus> = new Set([
  "queued",
  "working",
  "waiting_for_input",
  "stopping",
]);

/** A reply that is running its session now (not merely waiting its turn). */
export const RUNNING_STATUSES: ReadonlySet<MessageStatus> = new Set([
  "working",
  "waiting_for_input",
  "stopping",
]);

/**
 * `known` with `incoming` folded in: a row we already hold at the same or a later revision stays
 * as it is, a newer one replaces it where it stands, a new one goes in `seq` order. When nothing
 * changes the answer is `known` itself, and rows that did not change keep their objects, which is
 * what lets a memoised row skip rendering.
 */
export function mergeRows(
  known: readonly MessageView[],
  incoming: readonly MessageView[],
): readonly MessageView[] {
  if (incoming.length === 0) return known;
  const byId = new Map(known.map((row) => [row.id, row]));
  let changed = false;
  for (const row of incoming) {
    const held = byId.get(row.id);
    if (held !== undefined && held.revision >= row.revision) continue;
    byId.set(row.id, row);
    changed = true;
  }
  if (!changed) return known;
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
