import type { Entry, MessageEntry, NewEntry } from "@eta/core/session";
import { EntryGraph, forkChain } from "@eta/core/session";
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

const textOf = (entry: Entry): string | undefined => {
  if (entry.type !== "message") return undefined;
  const message = (entry as MessageEntry).message;
  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "toolResult"
  )
    return undefined;
  const content = message.content;
  return Array.isArray(content)
    ? (content[0] as { text: string }).text
    : undefined;
};

/** a -> b -> c -> d on one branch. */
function chain4() {
  const g = new EntryGraph();
  const a = g.append(msg("a"));
  const b = g.append(msg("b"));
  const c = g.append(msg("c"));
  const d = g.append(msg("d"));
  return { g, a, b, c, d };
}

/** The ids a fork copies, sorted, and where its tip points. */
const selection = (
  graph: EntryGraph,
  options?: Parameters<typeof forkChain>[1],
) => {
  const fork = forkChain(graph, options);
  return { tip: fork.tipId, ids: fork.entries.map((e) => e.id).sort() };
};

// "position before" and an unknown entry id are pinned through
// SessionManager.fork (eta-server manager.test.ts "forking").
describe("fork selection", () => {
  it("defaults to the tip, position at: the whole branch is copied", () => {
    const { g, a, b, c, d } = chain4();
    expect(selection(g)).toEqual({
      tip: d.id,
      ids: [a.id, b.id, c.id, d.id].sort(),
    });
  });

  it("position at keeps the selected entry as the destination tip", () => {
    const { g, a, b, c } = chain4();
    expect(selection(g, { entryId: c.id })).toEqual({
      tip: c.id,
      ids: [a.id, b.id, c.id].sort(),
    });
  });

  it("forking at the root with position before yields an empty destination", () => {
    const { g, a } = chain4();
    expect(selection(g, { entryId: a.id, position: "before" })).toEqual({
      tip: null,
      ids: [],
    });
  });

  it("rejects an entry that is not on the current branch", () => {
    const { g, a, d } = chain4();
    const side = g.append(msg("side work", a.id));
    // Appending advances the tip; a side-branch write leaves the branch view
    // where it was. The tip chain is now d -> c -> b -> a again.
    g.setTip(d.id);
    expect(g.tipId()).toBe(d.id);
    expect(() => forkChain(g, { entryId: side.id })).toThrow(
      "not on the current branch",
    );
    // …but the side entry is still reachable and forkable from its own chain.
    g.setTip(side.id);
    expect(forkChain(g, { entryId: a.id }).tipId).toBe(a.id);
  });

  it("rejects forking an empty branch", () => {
    const g = new EntryGraph();
    expect(() => forkChain(g)).toThrow("source branch is empty");
  });
});

describe("forkChain", () => {
  it("materializes a standalone copy a destination can adopt", () => {
    const { g, a, b, c } = chain4();
    const fork = forkChain(g, { entryId: c.id });
    expect(fork.tipId).toBe(c.id);
    expect(fork.entries.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect(fork.entries.map(textOf)).toEqual(["c", "b", "a"]);
  });

  it("the destination graph accepts the copied chain and continues from it", () => {
    const { g, c } = chain4();
    const fork = forkChain(g, { entryId: c.id });
    const dest = new EntryGraph();
    for (const entry of [...fork.entries].reverse()) {
      dest.append(entry);
    }
    expect(dest.tipId()).toBe(fork.tipId);
    expect(dest.pathOldestFirst().map(textOf)).toEqual(["a", "b", "c"]);
    // The fork continues as its own history; the source is untouched.
    const next = dest.append(msg("fork work"));
    expect(next.parentId).toBe(c.id);
    expect(g.tipId()).not.toBe(next.id);
  });
});
