/**
 * The rules that need no database: who a message wakes, what the budget allows, what a woken
 * agent is told.
 */
import type { MessageView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { briefing } from "../src/conversations/briefing";
import {
  judgeMention,
  resolveNamed,
  routeUserMessage,
  WAKE_BUDGET,
} from "../src/conversations/routing";

describe("routeUserMessage", () => {
  const base = {
    kind: "group" as const,
    members: ["a", "b", "c"],
    steward: null,
  };

  it("wakes the members named, once each, in the order named", () => {
    expect(
      routeUserMessage({ ...base, mentions: ["c", "a", "c"], steward: "b" }),
    ).toEqual({ targets: ["c", "a"], addSteward: false, named: ["c", "a"] });
  });

  it("ignores names that are not members", () => {
    expect(routeUserMessage({ ...base, mentions: ["z", "b"] }).targets).toEqual(
      ["b"],
    );
    // Naming only strangers is naming nobody.
    expect(
      routeUserMessage({ ...base, mentions: ["z"], steward: "a" }),
    ).toEqual({ targets: ["a"], addSteward: false, named: [] });
  });

  it("goes to the steward when nobody is named, and brings a steward who is not a member", () => {
    expect(routeUserMessage({ ...base, mentions: [], steward: "b" })).toEqual({
      targets: ["b"],
      addSteward: false,
      named: [],
    });
    expect(routeUserMessage({ ...base, mentions: [], steward: "z" })).toEqual({
      targets: ["z"],
      addSteward: true,
      named: [],
    });
  });

  it("goes to the only member when there is no steward", () => {
    expect(
      routeUserMessage({ ...base, members: ["a"], mentions: [] }).targets,
    ).toEqual(["a"]);
  });

  it("wakes nobody when there is no steward and more than one member", () => {
    expect(routeUserMessage({ ...base, mentions: [] })).toEqual({
      targets: [],
      addSteward: false,
      named: [],
    });
    expect(
      routeUserMessage({ ...base, members: [], mentions: [] }).targets,
    ).toEqual([]);
  });

  it("sends a private chat to its agent whatever else is true", () => {
    expect(
      routeUserMessage({
        kind: "direct",
        members: ["a"],
        mentions: [],
        steward: "someone-else",
      }),
    ).toEqual({ targets: ["a"], addSteward: false, named: [] });
  });
});

describe("judgeMention", () => {
  it("lets the first four through, reminds on the fifth, and holds the rest back", () => {
    expect(WAKE_BUDGET).toBe(5);
    expect([1, 2, 3, 4].map(judgeMention)).toEqual([
      "wake",
      "wake",
      "wake",
      "wake",
    ]);
    expect(judgeMention(5)).toBe("wake_last");
    expect([6, 7, 100].map(judgeMention)).toEqual([
      "capped",
      "capped",
      "capped",
    ]);
  });
});

describe("resolveNamed", () => {
  const members = [
    { id: "a1", name: "Ada" },
    { id: "b1", name: "Bob" },
  ];

  it("finds a member by name in any case, by id, and with an at sign", () => {
    expect(resolveNamed(["ada", "@Bob"], members, "z").ids).toEqual([
      "a1",
      "b1",
    ]);
    expect(resolveNamed(["b1"], members, "z").ids).toEqual(["b1"]);
  });

  it("reports what it could not find, and never wakes the speaker", () => {
    expect(resolveNamed(["Ada", "Zed", "ada"], members, "a1")).toEqual({
      ids: [],
      unknown: ["Zed"],
    });
  });
});

describe("briefing", () => {
  const row = (
    seq: number,
    fields: Partial<MessageView> & { text: string },
  ): MessageView => ({
    id: `m${seq}`,
    conversationId: "c",
    seq,
    kind: "message",
    author: "user",
    agentId: null,
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
  });
  const names: Record<string, string> = { a: "Ada", b: "Bob" };
  const nameOf = (message: MessageView): string =>
    message.author === "user"
      ? "the user"
      : message.author === "system"
        ? "system"
        : (names[message.agentId ?? ""] ?? "another agent");
  const tell = (
    rows: MessageView[],
    triggerSeq: number,
    lastSeq = 0,
    me = "a",
  ) =>
    briefing({
      conversation: "plans",
      me,
      lastSeq,
      rows,
      trigger: rows.find((r) => r.seq === triggerSeq)!,
      nameOf,
    });

  it("is only the message when there is nothing since the agent last looked", () => {
    const told = tell([row(1, { text: "hello" })], 1);
    expect(told.text).toBe("[conversation: plans]\nthe user says:\nhello");
    expect(told.seen).toBe(1);
  });

  it("puts what was missed before the message, with who said it", () => {
    const told = tell(
      [
        row(1, { text: "first" }),
        row(2, { text: "second", author: "agent", agentId: "b" }),
        row(3, { text: "now" }),
      ],
      3,
    );
    expect(told.text).toBe(
      [
        "[conversation: plans]",
        "Since you last looked:",
        "- the user: first",
        "- Bob: second",
        "",
        "the user says:",
        "now",
      ].join("\n"),
    );
    expect(told.seen).toBe(3);
  });

  it("does not repeat the agent's own replies, and moves past them", () => {
    const told = tell(
      [
        row(1, { text: "q" }),
        row(2, { text: "mine", author: "agent", agentId: "a" }),
        row(3, { text: "q2" }),
      ],
      3,
      1,
    );
    expect(told.text).not.toContain("mine");
    expect(told.seen).toBe(3);
  });

  it("holds the mark before a reply that is still being written, so its text comes later", () => {
    const told = tell(
      [
        row(1, { text: "q" }),
        row(2, { text: "", author: "agent", agentId: "b", status: "working" }),
        row(3, { text: "q2" }),
      ],
      3,
    );
    expect(told.text).toContain("- the user: q");
    expect(told.seen).toBe(1);
  });

  it("skips replies that ended with nothing to say", () => {
    const told = tell(
      [
        row(1, { text: "", author: "agent", agentId: "b", status: "stopped" }),
        row(2, { text: "now" }),
      ],
      2,
    );
    expect(told.text).toBe("[conversation: plans]\nthe user says:\nnow");
    expect(told.seen).toBe(2);
  });

  it("names the speaker of a mention, and tells system rows as system", () => {
    const told = tell(
      [
        row(1, {
          text: "Bob is now the steward.",
          author: "system",
          kind: "system",
        }),
        row(2, {
          text: "look at this",
          author: "agent",
          agentId: "b",
          kind: "mention",
        }),
      ],
      2,
    );
    expect(told.text).toContain("- system: Bob is now the steward.");
    expect(told.text).toContain("Bob says:\nlook at this");
  });

  it("cuts a long backlog to its newest part and says so", () => {
    const rows = [
      ...Array.from({ length: 130 }, (_, index) =>
        row(index + 1, { text: `line ${index + 1}` }),
      ),
      row(131, { text: "now" }),
    ];
    const told = tell(rows, 131);
    expect(told.text).toContain("(30 earlier messages left out)");
    expect(told.text).not.toContain("- the user: line 30\n");
    expect(told.text).toContain("- the user: line 31\n");
    expect(told.text).toContain("- the user: line 130\n");
    expect(told.seen).toBe(131);
  });

  it("clips a very long message", () => {
    const told = tell(
      [row(1, { text: "x".repeat(5_000) }), row(2, { text: "now" })],
      2,
    );
    const line = told.text
      .split("\n")
      .find((l) => l.startsWith("- the user:"))!;
    expect(line.length).toBeLessThan(2_100);
    expect(line.endsWith("...")).toBe(true);
  });

  it("delivers a trigger it was already shown, without moving the mark back", () => {
    const told = tell([row(1, { text: "again" })], 1, 5);
    expect(told.text).toContain("the user says:\nagain");
    expect(told.seen).toBe(5);
  });
});
