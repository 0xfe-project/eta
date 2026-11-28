import type { MergeEntry, MessageEntry, NewEntry } from "@eta/core/session";
import { EntryGraph, rollback } from "@eta/core/session";
import { describe, expect, it } from "vitest";

const msg = (
  text: string,
  parentId: string | null = null,
): NewEntry<MessageEntry> => ({
  id: crypto.randomUUID(),
  parentId,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

const texts = (graph: EntryGraph): string[] =>
  graph.pathOldestFirst().flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = (entry as MessageEntry).message;
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    )
      return [];
    const content = message.content;
    return Array.isArray(content)
      ? content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
      : [];
  });

/**
 * Shared history, a side branch, main-line work, and a merge entry joining the
 * side in — the shape an imported eta-agent journal can have.
 */
function d4() {
  const main = new EntryGraph();
  const shared = main.append(msg("shared history"));
  const sideEntry = main.append(msg("side work", shared.id));
  main.setTip(shared.id);
  const mainWork = main.append(msg("main work"));
  return { main, shared, sideEntry, mainWork };
}

function merge(graph: EntryGraph, mergedParentId: string): MergeEntry {
  return graph.append({
    parentId: graph.tipId(),
    type: "merge",
    mergedParentId,
    summary: "merge side into main",
  } as NewEntry<MergeEntry>);
}

describe("rollback", () => {
  it("moves the branch view back, keeping the entry and the discarded history", () => {
    const { main, shared, sideEntry, mainWork } = d4();
    const joined = merge(main, sideEntry.id);

    const result = rollback(main, mainWork.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entryId).toBe(mainWork.id);
    expect(result.droppedIds.sort()).toEqual([joined.id, sideEntry.id].sort());

    expect(main.pathOldestFirst().map((entry) => entry.id)).toEqual([
      shared.id,
      mainWork.id,
    ]);
    // Dropped from the path, not deleted: the graph still holds them.
    expect(main.byId(joined.id)).toBeDefined();
    expect(main.byId(sideEntry.id)).toBeDefined();
  });

  it("continues from the rolled-back tip instead of the old head", () => {
    const { main, sideEntry, mainWork } = d4();
    merge(main, sideEntry.id);
    rollback(main, mainWork.id);
    const next = main.append(msg("second try"));
    expect(next.parentId).toBe(mainWork.id);
    expect(texts(main)).toEqual(["shared history", "main work", "second try"]);
  });

  it("rolling back to a merge entry keeps the merged chain visible", () => {
    const { main, sideEntry } = d4();
    const joined = merge(main, sideEntry.id);
    main.append(msg("post-merge work"));

    const result = rollback(main, joined.id);
    expect(result.ok).toBe(true);
    expect(texts(main)).toEqual(["shared history", "main work", "side work"]);
  });

  it("refuses entries that are unknown or off the current branch", () => {
    const { main, sideEntry } = d4();
    const unknown = rollback(main, "ghost");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("unreachable");
    expect(unknown.reason).toContain("unknown entry");

    merge(main, sideEntry.id);
    const offBranch = rollback(main, sideEntry.id);
    expect(offBranch.ok).toBe(false);
    if (offBranch.ok) throw new Error("unreachable");
    expect(offBranch.reason).toContain("not on the current branch");
  });
});
