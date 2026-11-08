/** The rows a conversation's feed keeps: windows and older pages folded in, held ones left out. */
import type { MessageView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { foldWindow, visibleRows } from "../../src/ext/conversation/feed/rows";

function row(seq: number, fields: Partial<MessageView> = {}): MessageView {
  return {
    id: `m${seq}`,
    conversationId: "c1",
    seq,
    kind: "message",
    author: "user",
    agentId: null,
    text: `row ${seq}`,
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

const ids = (rows: readonly MessageView[]) => rows.map((r) => r.id);

describe("foldWindow", () => {
  it("drops a row inside the window's span that the window no longer has", () => {
    const known = [row(1), row(2), row(3), row(4)];
    expect(ids(foldWindow(known, [row(2), row(4)]))).toEqual([
      "m1",
      "m2",
      "m4",
    ]);
  });

  it("keeps a row above the window's span (one just sent)", () => {
    const known = [row(1), row(2), row(9)];
    expect(ids(foldWindow(known, [row(1), row(2)]))).toEqual([
      "m1",
      "m2",
      "m9",
    ]);
  });

  it("takes a newer revision in place and keeps an older one out", () => {
    const working = row(2, { status: "working", revision: 2 });
    const done = row(2, { status: "done", revision: 3 });
    expect(foldWindow([row(1), working], [row(1), done])[1]).toBe(done);
    expect(foldWindow([row(1), done], [row(1), working])[1]).toBe(done);
  });
});

describe("visibleRows", () => {
  it("hides the replies waiting under a held message, and nothing else", () => {
    const held = row(5, { id: "held1" });
    const waiting = row(6, {
      author: "agent",
      rootMessageId: "held1",
      agentId: "a",
    });
    const other = row(7, {
      author: "agent",
      rootMessageId: "m1",
      agentId: "a",
    });
    const userUnder = row(8, { rootMessageId: "held1" });
    const known = [row(1), waiting, other, userUnder];
    expect(ids(visibleRows(known, [held]))).toEqual(["m1", "m7", "m8"]);
  });
});
