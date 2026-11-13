// A conversation's timeline as rows the phone has seen: the newest window the host publishes, older
// pages fetched on demand, and what our own `send` and `stop` calls answered with. Same rules as
// apps/web/src/lib/timeline.ts and queries/conversations.ts.

import type { MessageStatus, MessageView } from "@eta/client-contracts";
import type { Signal } from "nsh";
import { isCaptainGroupOutcome } from "@eta/client-contracts";
import { signal, untracked } from "nsh";

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
 * `known` with `incoming` folded in: a row held at the same or a later revision stays, a newer one
 * replaces it where it stands, a new one goes in `seq` order.
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

/**
 * The task rows that name the reply they came out of, gathered under it: a draft stays attached to
 * the turn that proposed it, and the card it becomes stays put. A row that names no turn on this
 * page stays on the timeline rather than vanish at a page boundary. The message that tells Captain
 * how its group proposal ended is Captain's context, not the reader's, and is not drawn.
 */
export function taskRowsByTurn(messages: readonly MessageView[]): {
  rows: readonly MessageView[];
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
    if (isCaptainGroupOutcome(row)) continue;
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

const NONE: readonly MessageView[] = [];
const stores = new Map<string, Signal<readonly MessageView[]>>();

/** Every row seen of a conversation, oldest first. Survives leaving the screen. */
export function rowsOf(conversationId: string): Signal<readonly MessageView[]> {
  let store = stores.get(conversationId);
  if (store === undefined) {
    store = signal<readonly MessageView[]>(NONE);
    stores.set(conversationId, store);
  }
  return store;
}

/** Keep rows learned of outside the target: an older page, what a `send` or a `stop` answered. */
export function rememberRows(
  conversationId: string,
  rows: readonly MessageView[],
): void {
  const store = rowsOf(conversationId);
  const known = untracked(() => store());
  const merged = mergeRows(known, rows);
  if (merged !== known) store.set(merged);
}

/** Forget a recalled message and the replies under it: it never was a message. */
export function forgetRows(
  conversationId: string,
  ids: readonly string[],
): void {
  const gone = new Set(ids);
  const store = rowsOf(conversationId);
  const known = untracked(() => store());
  const kept = known.filter(
    (row) =>
      !gone.has(row.id) &&
      !gone.has(row.rootMessageId ?? "") &&
      !gone.has(row.replyToId ?? ""),
  );
  if (kept.length !== known.length) store.set(kept);
}

/**
 * Inside the span the host's window covers, the window is the whole truth: a row missing from it
 * was recalled, is waiting for a lane or fell to a compaction. Outside it nothing is dropped.
 */
export function settleWindow(
  conversationId: string,
  window: readonly MessageView[],
): void {
  rememberRows(conversationId, window);
  if (window.length === 0) return;
  const seqs = window.map((row) => row.seq);
  const from = Math.min(...seqs);
  const to = Math.max(...seqs);
  const present = new Set(window.map((row) => row.id));
  const store = rowsOf(conversationId);
  const known = untracked(() => store());
  const kept = known.filter(
    (row) => row.seq < from || row.seq > to || present.has(row.id),
  );
  if (kept.length !== known.length) store.set(kept);
}
