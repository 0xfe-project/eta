import { describe, expect, it } from "@rstest/core";
import { messageView } from "@/test-product";
import { mergeRows, taskRowsByTurn } from "./timeline";

const row = (seq: number, revision = 1, text = "") =>
  messageView({ id: `r${seq}`, conversationId: "c", seq, revision, text });

describe("folding rows into a timeline", () => {
  it("puts new rows in seq order", () => {
    const merged = mergeRows([row(2), row(4)], [row(3), row(1)]);
    expect(merged.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("replaces a row with a newer revision of itself where it stands", () => {
    const merged = mergeRows([row(1), row(2, 1, "old")], [row(2, 2, "new")]);
    expect(merged.map((r) => r.text)).toEqual(["", "new"]);
  });

  it("ignores a copy that is not newer, and keeps everything when nothing changed", () => {
    const known = [row(1, 3, "kept"), row(2)];
    expect(mergeRows(known, [row(1, 3, "same"), row(1, 2, "older")])).toBe(
      known,
    );
    expect(mergeRows(known, [])).toBe(known);
  });

  it("leaves the rows that did not change as the same objects", () => {
    const known = [row(1), row(2)];
    const merged = mergeRows(known, [row(3)]);
    expect(merged[0]).toBe(known[0]);
    expect(merged[1]).toBe(known[1]);
  });
});

const reply = (id: string, seq: number) =>
  messageView({
    id,
    conversationId: "c",
    seq,
    author: "agent",
    agentId: "a1",
    status: "done",
  });
const draft = (seq: number, turnMessageId?: string) =>
  messageView({
    id: `draft-${seq}`,
    conversationId: "c",
    seq,
    kind: "task_draft",
    author: "agent",
    agentId: "a1",
    data: turnMessageId === undefined ? {} : { turnMessageId },
  });

describe("gathering the task rows under the reply that wrote them", () => {
  it("takes a draft naming a reply that is here, and leaves the rest alone", () => {
    const split = taskRowsByTurn([
      reply("t1", 1),
      draft(2),
      draft(3, "t1"),
      draft(4, "not-here"),
    ]);
    // The words stay where they are; a draft that names no turn, or one this page is not showing,
    // stays on the timeline too.
    expect(split.rows.map((row) => row.id)).toEqual([
      "t1",
      "draft-2",
      "draft-4",
    ]);
    expect(split.under.get("t1")?.map((row) => row.id)).toEqual(["draft-3"]);
  });

  it("keeps several drafts under their turn in order, and each turn's own", () => {
    const split = taskRowsByTurn([
      reply("t1", 1),
      reply("t2", 2),
      draft(3, "t2"),
      draft(4, "t1"),
      draft(5, "t1"),
    ]);
    expect(split.rows.map((row) => row.id)).toEqual(["t1", "t2"]);
    expect(split.under.get("t1")?.map((row) => row.id)).toEqual([
      "draft-4",
      "draft-5",
    ]);
    expect(split.under.get("t2")?.map((row) => row.id)).toEqual(["draft-3"]);
  });

  it("refuses a turn that is not an agent's reply", () => {
    // A row of someone else's, or of the system's, is not a turn a draft came out of: the draft
    // stays where the timeline put it rather than disappearing into it.
    const split = taskRowsByTurn([
      messageView({ id: "u1", conversationId: "c", seq: 1 }),
      draft(2, "u1"),
    ]);
    expect(split.rows.map((row) => row.id)).toEqual(["u1", "draft-2"]);
    expect(split.under.size).toBe(0);
  });
});

describe("the message Captain is told how its group proposal ended", () => {
  it("is not on the timeline: the card shows the outcome", () => {
    const outcome = messageView({
      id: "outcome",
      conversationId: "c",
      seq: 2,
      author: "system",
      text: "Your proposed group …",
      data: { captainGroupOutcome: { operationId: "o1", status: "applied" } },
    });
    const split = taskRowsByTurn([reply("t1", 1), outcome, reply("t2", 3)]);
    expect(split.rows.map((r) => r.id)).toEqual(["t1", "t2"]);
  });
});
