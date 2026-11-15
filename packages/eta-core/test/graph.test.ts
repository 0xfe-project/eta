import type {
  Entry,
  GraphNode,
  MessageEntry,
  NewEntry,
} from "@eta/core/session";
import { EntryGraph, spliceMergedChain } from "@eta/core/session";
import { describe, expect, it } from "vitest";

const msg = (text: string): NewEntry<MessageEntry> => ({
  id: crypto.randomUUID(),
  parentId: null,
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

describe("entry graph", () => {
  it("appends on the tip, building single-parent chains", () => {
    const g = new EntryGraph();
    const a = g.append(msg("a"));
    const b = g.append(msg("b"));
    expect(b.parentId).toBe(a.id);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(g.tip()?.id).toBe(b.id);
    expect(g.chain().map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("rejects appends onto unknown parents", () => {
    const g = new EntryGraph();
    expect(() =>
      g.append({ ...msg("x"), parentId: "ghost" } as NewEntry<Entry>),
    ).toThrow("unknown parent");
  });

  it("setTip moves the branch view; chain/path follow it", () => {
    const g = new EntryGraph();
    const a = g.append(msg("a"));
    g.append(msg("b"));
    g.setTip(a.id);
    expect(g.tip()?.id).toBe(a.id);
    expect(g.pathOldestFirst().map((e) => e.id)).toEqual([a.id]);
    expect(() => g.setTip("ghost")).toThrow("unknown entry");
  });
});

describe("spliceMergedChain", () => {
  it("splices the merged chain after the merge entry, stopping at the common ancestor", () => {
    // Build by hand: root <- main <- merge(mergedParent=side)
    //                              side <- root(ancestor, already on path)
    const root = { id: "root", parentId: null, type: "message" };
    const main = { id: "main", parentId: "root", type: "message" };
    const side = { id: "side", parentId: "root", type: "message" };
    const merge = {
      id: "merge",
      parentId: "main",
      type: "merge",
      mergedParentId: "side",
    };
    const all = new Map([root, main, side, merge].map((e) => [e.id, e]));

    const path = [merge, main, root];
    spliceMergedChain(path, (id) => all.get(id));
    // The merged chain joins right after the merge entry (newest-first);
    // reversed it reads exactly like the old backends' oldest-first order.
    expect(path.map((e) => e.id)).toEqual(["merge", "side", "main", "root"]);
  });

  it("a merge whose merged parent is already on the path adds nothing", () => {
    const a: GraphNode = { id: "a", parentId: null, type: "message" };
    const b: GraphNode = {
      id: "b",
      parentId: "a",
      type: "merge",
      mergedParentId: "a",
    };
    const all = new Map([a, b].map((e) => [e.id, e]));
    const path = [b, a];
    spliceMergedChain(path, (id) => all.get(id));
    expect(path.map((e) => e.id)).toEqual(["b", "a"]);
  });
});
