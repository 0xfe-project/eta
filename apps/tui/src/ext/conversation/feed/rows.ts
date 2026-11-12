// The row handling of apps/web/src/queries/conversations.ts, as plain functions over the rows a
// feed holds.
import type { MessageView } from "@eta/client-contracts";
import { mergeRows } from "../model/timeline";

/**
 * `known` with the newest window folded in. Inside the span of seqs the window covers, the window
 * is the whole truth: a row missing from it is waiting for a lane, was recalled, or a compaction
 * dropped it. Outside the span nothing is dropped: an older page lies below it, and a message sent
 * a moment ago can lie above it until the next window. Answers `known` itself when nothing changed.
 */
export function foldWindow(
  known: readonly MessageView[],
  window: readonly MessageView[],
): readonly MessageView[] {
  if (window.length === 0) return known;
  const merged = mergeRows(known, window);
  const seqs = window.map((row) => row.seq);
  const from = Math.min(...seqs);
  const to = Math.max(...seqs);
  const present = new Set(window.map((row) => row.id));
  const kept = merged.filter(
    (row) => row.seq < from || row.seq > to || present.has(row.id),
  );
  return kept.length === merged.length ? merged : kept;
}

/**
 * The rows to draw: a reply waiting under a held message is not in the conversation yet, and the
 * host keeps such replies in its window (they carry no `held` of their own). Answers `known`
 * itself when nothing is hidden.
 */
export function visibleRows(
  known: readonly MessageView[],
  held: readonly MessageView[],
): readonly MessageView[] {
  if (held.length === 0) return known;
  const waitingOn = new Set(held.map((row) => row.id));
  const shown = known.filter(
    (row) => row.author !== "agent" || !waitingOn.has(row.rootMessageId ?? ""),
  );
  return shown.length === known.length ? known : shown;
}
