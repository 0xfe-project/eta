import type { Entry, MessageEntry, NewEntry } from "@eta/core/session";
import { EntryGraph, forkChain, selectBranchFork } from "@eta/core/session";
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

describe("selectBranchFork", () => {
  it("defaults to the tip, position at: the whole branch is copied", () => {
    const { g, a, b, c, d } = chain4();
    const sel = selectBranchFork(g);
    expect(sel.destinationTip).toBe(d.id);
    expect([...sel.entryIds].sort()).toEqual([a.id, b.id, c.id, d.id].sort());
  });

  it("position at keeps the selected entry as the destination tip", () => {
    const { g, a, b, c } = chain4();
    const sel = selectBranchFork(g, { entryId: c.id });
    expect(sel.destinationTip).toBe(c.id);
    expect([...sel.entryIds].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it("position before stops at the parent of the selected entry", () => {
    const { g, a, b, c } = chain4();
    const sel = selectBranchFork(g, { entryId: c.id, position: "before" });
    expect(sel.destinationTip).toBe(b.id);
    expect([...sel.entryIds].sort()).toEqual([a.id, b.id].sort());
  });

  it("forking at the root with position before yields an empty destination", () => {
    const { g, a } = chain4();
    const sel = selectBranchFork(g, { entryId: a.id, position: "before" });
    expect(sel.destinationTip).toBeNull();
    expect(sel.entryIds.size).toBe(0);
  });

  it("rejects an entry that is not on the current branch", () => {
    const { g, a, d } = chain4();
    const side = g.append(msg("side work", a.id));
    // Appending advances the tip; a side-branch write leaves the branch view
    // where it was. The tip chain is now d -> c -> b -> a again.
    g.setTip(d.id);
    expect(g.tipId()).toBe(d.id);
    expect(() => selectBranchFork(g, { entryId: side.id })).toThrow(
      "not on the current branch",
    );
    // …but the side entry is still reachable and forkable from its own chain.
    g.setTip(side.id);
    expect(selectBranchFork(g, { entryId: a.id }).destinationTip).toBe(a.id);
  });

  it("rejects an unknown entry id", () => {
    const { g } = chain4();
    expect(() => selectBranchFork(g, { entryId: "ghost" })).toThrow(
      "not on the current branch",
    );
  });

  it("rejects forking an empty branch", () => {
    const g = new EntryGraph();
    expect(() => selectBranchFork(g)).toThrow("source branch is empty");
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

  it("a fork carries no back-pointer to the source session", () => {
    const { g, c } = chain4();
    const fork = forkChain(g, { entryId: c.id });
    for (const entry of fork.entries) {
      expect(Object.keys(entry)).not.toContain("parentSessionId");
      expect(Object.keys(entry)).not.toContain("sourceSessionId");
    }
  });
});
