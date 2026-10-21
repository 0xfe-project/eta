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
 * The task rows that name the reply they came out of (`data.turnMessageId`), gathered under it.
 *
 * A draft is a request the turn is making of the reader, so the page draws it inside that turn
 * rather than as a block of its own further down the timeline, and the card it becomes stays put.
 * Naming the row is what makes this need no guessing about order: two drafts from one turn and a
 * turn that started before the last one finished all read correctly.
 *
 * A row is left on the timeline as it was drawn when it names no turn (it was written before a
 * draft knew one) or names one this page is not showing (an older page of the conversation): a card
 * the reader can neither place nor lose is better than a card that vanished at a page boundary.
 */
export function taskRowsByTurn(messages: readonly MessageView[]): {
  /** The rows to draw on the timeline, in the order they came in. */
  rows: readonly MessageView[];
  /** The rows to draw inside a reply, by that reply's row id, oldest first. */
  under: ReadonlyMap<string, readonly MessageView[]>;
} {
  const turns = new Set(
    messages
      .filter(
        (row) =>
          row.author === "agent" &&
          (row.kind === "message" || row.kind === "mention"),
      )
      .map((row) => row.id),
  );
  const rows: MessageView[] = [];
  const under = new Map<string, MessageView[]>();
  for (const row of messages) {
    const turn =
      row.kind === "task_draft" || row.kind === "task_card"
        ? row.data.turnMessageId
        : undefined;
    if (typeof turn !== "string" || !turns.has(turn)) {
      rows.push(row);
      continue;
    }
    under.set(turn, [...(under.get(turn) ?? []), row]);
  }
  return { rows, under };
}

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
