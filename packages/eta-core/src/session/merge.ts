/**
 * Rollback — a branch operation on the entry graph (REFACTOR.md §K4, port of
 * eta-agent's rollback semantics, storage and lane coupling stripped).
 *
 * Rollback moves the branch view back and keeps the discarded entries — the
 * history is not deleted, only unreachable from the new tip. Merge entries an
 * imported journal holds are read by spliceMergedChain (graph.ts).
 */
import type { EntryGraph } from "./graph";

export type RollbackResult =
  | { ok: true; entryId: string; droppedIds: string[] }
  | { ok: false; reason: string };

/**
 * Move the branch view back to `entryId`, keeping it. Everything after it
 * leaves the path but stays in the graph, so a later replay still sees it.
 */
export function rollback(graph: EntryGraph, entryId: string): RollbackResult {
  if (graph.byId(entryId) === undefined)
    return { ok: false, reason: `unknown entry ${entryId}` };
  if (!graph.chain().some((entry) => entry.id === entryId)) {
    return {
      ok: false,
      reason: `entry ${entryId} is not on the current branch`,
    };
  }
  const before = new Set(graph.path().map((entry) => entry.id));
  graph.setTip(entryId);
  const after = new Set(graph.path().map((entry) => entry.id));
  const droppedIds = [...before].filter((id) => !after.has(id));
  return { ok: true, entryId, droppedIds };
}
