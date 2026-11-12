/**
 * One waiting item handled where the user is: each way of answering a question and what it
 * sends, the two kinds of task and what they send, a call in flight, a failure, an item handled
 * elsewhere, going to its conversation, and leaving.
 */
import type { InteractionView } from "@eta/client-contracts";
import type { KeyBinding } from "../../src/config/types";
import type { RenderedApp } from "../ui-support/app";
import type { PendingWorld } from "./world";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { until } from "../support/temp";
import { renderApp } from "../ui-support/app";
import { testConfig } from "../ui-support/config";
import { fakeWire } from "../ui-support/fake-wire";
import { KEYS, plain, realDelay } from "../ui-support/render";
import { askedFor, PENDING_KEYS, screenShows, tabBar, twoRooms } from "./world";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const PANEL = "Waiting and conversations";

/** Opens the panel from the home screen and the first waiting item in it. */
async function openFirstItem(w: PendingWorld, expected: string) {
  const r = await w.show();
  await screenShows(r, () => !tabBar(r).endsWith("Pending 0"));
  await r.press(KEYS.left);
  await screenShows(r, PANEL);
  await r.press(KEYS.enter);
  await screenShows(r, expected);
  return r;
}

const closedBackToPanel = (r: RenderedApp) =>
  screenShows(r, (s) => s.includes(PANEL) && !s.includes("Decline"));

describe("answering a question", () => {
  it("with one choice sends that choice as the selection, and the panel is back", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await closedBackToPanel(r);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["blue"] } },
    ]);
    await until(() => w.interaction(q.id)?.status === "answered");
    expect(w.interaction(q.id)?.answer).toEqual({
      kind: "selection",
      selections: ["blue"],
    });
    expect(plain(r)).not.toContain("Which colour?");
  }, 60_000);

  it("with several choices sends every checked one, and nothing while none is checked", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which days?", {
      choices: ["mon", "tue", "wed"],
      multi: true,
    });
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
    expect(plain(r)).toContain("Which days?");

    await r.press(PENDING_KEYS.space);
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(PENDING_KEYS.space);
    // Checking and unchecking leaves it unchecked.
    await r.press(KEYS.up);
    await r.press(PENDING_KEYS.space);
    await r.press(PENDING_KEYS.space);
    await r.press(KEYS.enter);
    await closedBackToPanel(r);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["mon", "wed"] } },
    ]);
    await until(() => w.interaction(q.id)?.status === "answered");
  }, 60_000);

  it("without choices sends the text typed, trimmed, and nothing for blank text", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Any name?");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.type("   ");
    await r.press(KEYS.enter);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);

    await r.type(" te");
    // Up and down move between the lines; letters typed back on the text line go on the end.
    await r.press(KEYS.down);
    await r.press(KEYS.up);
    await r.type("al ");
    await r.press(KEYS.enter);
    await closedBackToPanel(r);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "freeform", text: "teal" } },
    ]);
    await until(() => w.interaction(q.id)?.status === "answered");
  }, 60_000);

  it("declines on the last line, which every question has", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const r = await openFirstItem(w, "Ben · Ben room");
    const screen = plain(r).split("\n");
    const red = screen.findIndex((line) => line.includes("red"));
    const blue = screen.findIndex((line) => line.includes("blue"));
    const decline = screen.findIndex((line) => line.includes("Decline"));
    expect(red).toBeLessThan(blue);
    expect(blue).toBeLessThan(decline);
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await closedBackToPanel(r);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "none" } },
    ]);
    await until(() => w.interaction(q.id)?.status !== "pending");
  }, 60_000);

  it("shows the question's first line in bold and at most 12 lines, then says where the rest is", async () => {
    const w = await twoRooms();
    const text = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    await w.askIn("Ben", w.ben.group.id, text);
    const r = await w.show(undefined, { rows: 40 });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    const screen = plain(r);
    expect(screen).toContain("Line 1");
    expect(screen).toContain("Line 12");
    expect(screen).not.toContain("Line 13");
    expect(screen).toContain("… (press alt+o for the whole conversation)");
    const raw = r.lastFrame().split("\n");
    const first = raw.find((line) => line.includes("Line 1"))!;
    const second = raw.find((line) => line.includes("Line 2"))!;
    const bold = "\u001B[1m";
    expect(first.indexOf(bold)).toBeGreaterThan(-1);
    expect(first.indexOf(bold)).toBeLessThan(first.indexOf("Line 1"));
    expect(second).not.toContain("\u001B[1m");
  }, 60_000);
});

describe("while an answer is on its way", () => {
  it("sends once however often Enter is pressed, and says it is sending", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    await screenShows(r, "Sending…");
    await r.press(KEYS.enter);
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    expect(askedFor(w.wire, "inbox.answer")).toHaveLength(1);
    w.wire.held[0]!.release();
    await closedBackToPanel(r);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["red"] } },
    ]);
  }, 60_000);

  it("keeps the item open with the error when the call fails, and a second try goes", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    w.wire.held[0]!.fail("the host broke");
    await screenShows(r, "the host broke");
    expect(plain(r)).toContain("Ben · Ben room");
    expect(plain(r)).not.toContain("Sending…");

    w.wire.holding.clear();
    await r.press(KEYS.enter);
    await closedBackToPanel(r);
    await until(() => w.interaction(q.id)?.status === "answered");
  }, 60_000);

  it("says it was already answered elsewhere when the host says so, and closes", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    await w.answerElsewhere(q.id, "blue");
    // The item went from the list while the call was on its way: that is not "handled elsewhere".
    expect(plain(r)).not.toContain("Handled elsewhere");
    w.wire.held[0]!.release();
    await screenShows(r, "Already answered elsewhere");
    await closedBackToPanel(r);
    expect(plain(r)).not.toContain("Handled elsewhere");
    expect(w.interaction(q.id)?.answer).toEqual({
      kind: "selection",
      selections: ["blue"],
    });
  }, 60_000);
});

describe("an item that goes away", () => {
  it("closes when it is answered elsewhere, saying so", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const r = await openFirstItem(w, "Ben · Ben room");
    await w.answerElsewhere(q.id, "red");
    await screenShows(r, "Handled elsewhere");
    await closedBackToPanel(r);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
  }, 60_000);

  it("closes when its task moves on elsewhere, saying so", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
    );
    const r = await openFirstItem(w, "#1 Ship it · in review");
    await w.moveTask(task.id, "done");
    await screenShows(r, "Handled elsewhere");
    await screenShows(
      r,
      (s) => s.includes(PANEL) && !s.includes("· in review"),
    );
  }, 90_000);
});

describe("going to the item's conversation", () => {
  it("closes the item and the panel and brings the conversation to the front", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const r = await openFirstItem(w, "Ben · Ben room");
    expect(plain(r)).toContain("alt+o");
    await r.press(PENDING_KEYS.openConversation);
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
    await screenShows(r, (s) => !s.includes(PANEL) && !s.includes("Decline"));
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
  }, 60_000);
});

describe("leaving and keys", () => {
  it("says the host is too old and sends nothing when it lacks the op", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.lacking.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    await screenShows(
      r,
      "This host is too old for this (missing inbox.answer)",
    );
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
  }, 60_000);
});

describe("a task in review", () => {
  it("shows its description and last comment, and accepting marks it done", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
      "Released it.",
    );
    const r = await openFirstItem(w, "#1 Ship it · in review");
    await screenShows(r, "Make the release");
    await screenShows(r, "Released it.");
    expect(
      plain(r)
        .split("\n")
        .some((l) => l.includes("Ada")),
    ).toBe(true);
    expect(plain(r)).toContain("Accept (mark done)");
    expect(plain(r)).toContain("Comment…");
    expect(plain(r)).not.toContain("Decline");
    await r.press(KEYS.enter);
    await screenShows(
      r,
      (s) => s.includes(PANEL) && !s.includes("· in review"),
    );
    expect(askedFor(w.wire, "tasks.update")).toEqual([
      { taskId: task.id, status: "done" },
    ]);
    await until(() => w.taskView(task.id)?.status === "done");
  }, 90_000);

  it("sends a comment typed on the comment line", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
    );
    const r = await openFirstItem(w, "#1 Ship it · in review");
    await r.press(KEYS.down);
    await r.type("one more thing");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Comment…"));
    expect(askedFor(w.wire, "tasks.comment")).toEqual([
      expect.objectContaining({ taskId: task.id, body: "one more thing" }),
    ]);
    expect(askedFor(w.wire, "tasks.update")).toEqual([]);
  }, 90_000);

  it("says it is loading until the task's details come, and its lines work meanwhile", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
    );
    w.wire.holdingTargets.add(`tasks.${task.id}`);
    const r = await openFirstItem(w, "#1 Ship it · in review");
    expect(plain(r)).toContain("Loading…");
    expect(plain(r)).not.toContain("Make the release");
    expect(w.wire.subscribed.get(`tasks.${task.id}`)).toBe(1);
    await r.press(KEYS.enter);
    await until(() => askedFor(w.wire, "tasks.update").length === 1);
    expect(askedFor(w.wire, "tasks.update")).toEqual([
      { taskId: task.id, status: "done" },
    ]);
  }, 90_000);

  it("follows the task's own target only while it is open", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
    );
    const r = await openFirstItem(w, "#1 Ship it · in review");
    expect(w.wire.subscribed.get(`tasks.${task.id}`)).toBe(1);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Accept"));
    expect(w.wire.subscribed.has(`tasks.${task.id}`)).toBe(false);
  }, 90_000);
});

describe("a blocked task", () => {
  it("shows its last comment and sends a reply", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
      "Which branch should I use?",
    );
    await w.moveTask(task.id, "blocked");
    const r = await openFirstItem(w, "#1 Ship it · blocked");
    await screenShows(r, "Which branch should I use?");
    expect(plain(r)).toContain("Reply…");
    expect(plain(r)).not.toContain("Accept (mark done)");
    await r.type("main");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Reply…"));
    expect(askedFor(w.wire, "tasks.comment")).toEqual([
      expect.objectContaining({ taskId: task.id, body: "main" }),
    ]);
  }, 90_000);
});

describe("the shell's subscriptions", () => {
  it("follow the inbox, the board and the agents while the shell shows", async () => {
    const w = await twoRooms();
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
    for (const target of ["inbox", "tasks", "agents"])
      expect(w.wire.subscribed.get(target)).toBeGreaterThan(0);
    r.unmount();
    for (const target of ["inbox", "tasks", "agents"])
      expect(w.wire.subscribed.has(target)).toBe(false);
  }, 60_000);
});

describe("the conversation key as the settings bind it", () => {
  const altG: KeyBinding = { key: "g", ctrl: false, alt: true, shift: false };
  const long = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join("\n");

  it("names a rebound key in the footer and in the line about the rest, and that key goes there", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, long);
    const base = testConfig();
    const r = await w.show(undefined, {
      rows: 40,
      config: testConfig({
        keybindings: {
          ...base.keybindings,
          "pending.openConversation": [altG],
        },
      }),
    });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    const footer = plain(r)
      .split("\n")
      .find((line) => line.includes("Esc"))!;
    expect(footer).toContain("alt+g conversation");
    expect(plain(r)).toContain("… (press alt+g for the whole conversation)");
    expect(plain(r)).not.toContain("alt+o");
    await r.press("\u001Bg");
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
  }, 60_000);

  it("names no key in the footer or the line about the rest when it is unbound", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, long);
    const base = testConfig();
    const r = await w.show(undefined, {
      rows: 40,
      config: testConfig({
        keybindings: { ...base.keybindings, "pending.openConversation": [] },
      }),
    });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    const footer = plain(r)
      .split("\n")
      .find((line) => line.includes("Esc"))!;
    expect(footer).not.toContain("conversation");
    expect(plain(r)).not.toContain("press");
    expect(plain(r)).toMatch(/^[^\w…]*…\W*$/m);
  }, 60_000);
});

describe("how much of a task shows", () => {
  const numbered = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join("\n");

  it("shows at most 8 lines of the description and 4 of the last comment", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
      numbered("Comment line ", 6),
    );
    await w.ask("tasks", "update", {
      taskId: task.id,
      description: numbered("Description line ", 12),
    });
    const r = await w.show(undefined, { rows: 40 });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    await r.press(KEYS.enter);
    await screenShows(r, "Description line 8");
    await screenShows(r, "Comment line 4");
    expect(plain(r)).toContain("Description line 1");
    expect(plain(r)).not.toContain("Description line 9");
    expect(plain(r)).toContain("Comment line 1");
    expect(plain(r)).not.toContain("Comment line 5");
  }, 90_000);

  it("shows a blocked task's last comment and not its description", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
      "Which branch should I use?",
    );
    await w.ask("tasks", "update", {
      taskId: task.id,
      description: "The description says this.",
    });
    await w.moveTask(task.id, "blocked");
    const r = await w.show(undefined, { rows: 40 });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    await r.press(KEYS.enter);
    await screenShows(r, "Which branch should I use?");
    expect(plain(r)).not.toContain("The description says this.");
  }, 90_000);
});

describe("an answer on its way when its layer closes", () => {
  it("is not sent again from the item opened again, which says it is sending and closes quietly when it lands", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    await screenShows(r, "Sending…");
    await r.press(KEYS.escape);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Decline"));
    await r.press(KEYS.enter);
    await screenShows(r, "Sending…");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    expect(askedFor(w.wire, "inbox.answer")).toHaveLength(1);

    w.wire.held[0]!.release();
    await until(() => w.interaction(q.id)?.status === "answered");
    await closedBackToPanel(r);
    await realDelay(200);
    const shown = r.stdout.frames.map((frame) =>
      stripVTControlCharacters(frame),
    );
    expect(shown.some((frame) => frame.includes("Handled elsewhere"))).toBe(
      false,
    );
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["red"] } },
    ]);
  }, 60_000);

  it("says in the status line when it fails after its layer closed", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    await r.press(KEYS.escape);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes(PANEL));
    w.wire.held[0]!.fail("the host broke");
    await screenShows(r, "the host broke");
  }, 60_000);
});

describe("an answer the host settles otherwise", () => {
  function question(): InteractionView {
    return {
      id: "q1",
      sessionId: "session-1",
      questionId: "call-1",
      agentId: "a1",
      conversationId: null,
      replyId: null,
      prompt: "Still there?",
      options: ["yes", "no"],
      multi: false,
      status: "pending",
      answer: null,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  // The host expires a question it can no longer deliver to (the run gave up first), which a
  // test cannot bring about on purpose; the wire here answers as the host does then.
  async function answerWith(status: InteractionView["status"]) {
    const target = (list: unknown) => ({
      sections: { list },
      revisions: {},
      version: 1,
    });
    const base = fakeWire({
      ops: ["inbox.answer"],
      targets: {
        inbox: target([question()]),
        agents: target([{ id: "a1", name: "Ada" }]),
        conversations: target([]),
        tasks: target([]),
      },
    });
    const wire = {
      ...base,
      call: async <T,>() =>
        ({
          interaction: { ...question(), status },
          answered: false,
        }) as T,
    };
    const r = await renderApp({ patch: { wire }, rows: 30 });
    await r.press(KEYS.left);
    await r.press(KEYS.enter);
    await screenShows(r, "Still there?");
    await r.press(KEYS.enter);
    return r;
  }

  it("says the question expired when the host expired it", async () => {
    const r = await answerWith("expired");
    await screenShows(
      r,
      "This question expired; the agent stopped waiting for it",
    );
    expect(plain(r)).not.toContain("Already answered elsewhere");
    r.unmount();
  });
});

describe("an item that goes away after a call of ours landed", () => {
  it("is handled elsewhere when a reply left the task blocked and it moves on later", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
      "Which branch should I use?",
    );
    await w.moveTask(task.id, "blocked");
    const r = await openFirstItem(w, "#1 Ship it · blocked");
    await r.type("main");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Reply…"));
    await until(() => askedFor(w.wire, "tasks.comment").length === 1);
    // The reply landed and the task still waits: it is there to open again.
    expect(w.taskView(task.id)?.status).toBe("blocked");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Ship it · blocked");
    await w.moveTask(task.id, "in_progress");
    await screenShows(r, "Handled elsewhere");
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Reply…"));
  }, 90_000);
});

describe("frames in the other order", () => {
  function question(status: InteractionView["status"]): InteractionView {
    return {
      id: "q1",
      sessionId: "session-1",
      questionId: "call-1",
      agentId: "a1",
      conversationId: null,
      replyId: null,
      prompt: "Still there?",
      options: ["yes", "no"],
      multi: false,
      status,
      answer: null,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  // The host in this process pushes the settled question before it replies; this wire lets the
  // test hold the push back until after the reply, the order another host may use.
  function heldWire() {
    const target = (list: unknown) => ({
      sections: { list },
      revisions: {},
      version: 1,
    });
    const base = fakeWire({
      ops: ["inbox.answer"],
      targets: {
        inbox: target([question("pending")]),
        agents: target([{ id: "a1", name: "Ada" }]),
        conversations: target([]),
        tasks: target([]),
      },
    });
    const replies: ((value: unknown) => void)[] = [];
    const wire = {
      ...base,
      call: <T,>() =>
        new Promise<T>((resolve) => {
          replies.push(resolve as (value: unknown) => void);
        }),
    };
    const push = () =>
      base.store.setState((s) => ({
        targets: { ...s.targets, inbox: target([question("answered")]) },
      }));
    return { wire, replies, push };
  }

  it("does not call the user's own answer handled elsewhere when the reply comes before the push", async () => {
    const w = heldWire();
    const r = await renderApp({ patch: { wire: w.wire }, rows: 30 });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    await r.press(KEYS.enter);
    await screenShows(r, "Still there?");
    await r.press(KEYS.enter);
    await screenShows(r, "Sending…");
    await r.press(KEYS.escape);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Decline"));
    w.replies[0]!({ answered: true, interaction: question("answered") });
    await realDelay(100);
    await r.press(KEYS.enter);
    await screenShows(r, "Still there?");
    w.push();
    await screenShows(r, (s) => !s.includes("Decline"));
    await realDelay(200);
    const shown = r.stdout.frames.map((frame) =>
      stripVTControlCharacters(frame),
    );
    expect(shown.some((frame) => frame.includes("Handled elsewhere"))).toBe(
      false,
    );
    expect(w.replies).toHaveLength(1);
    r.unmount();
  });
});

describe("where a failure is told", () => {
  /** The status line: the line over the tab bar. */
  const statusLines = (r: RenderedApp) =>
    r.stdout.frames.map(
      (frame) => stripVTControlCharacters(frame).split("\n").at(-2) ?? "",
    );

  it("is only in the item while it is open, not in the status line", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    w.wire.held[0]!.fail("the host broke");
    await screenShows(r, "the host broke");
    await realDelay(200);
    const line = plain(r)
      .split("\n")
      .findIndex((l) => l.includes("the host broke"));
    expect(line).toBeLessThan(plain(r).split("\n").length - 2);
    expect(statusLines(r).some((l) => l.includes("the host broke"))).toBe(
      false,
    );
  }, 60_000);

  it("belongs to the item that got it: opened again, the item shows no error", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    w.wire.held[0]!.fail("the host broke");
    await screenShows(r, "the host broke");
    await r.press(KEYS.escape);
    await screenShows(r, (s) => s.includes(PANEL) && !s.includes("Decline"));
    await r.press(KEYS.enter);
    await screenShows(r, "Decline");
    await realDelay(100);
    expect(plain(r)).not.toContain("the host broke");
  }, 60_000);

  it("says handled elsewhere in the status line when it fails after its item closed and went", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await openFirstItem(w, "Ben · Ben room");
    await r.press(KEYS.enter);
    await r.press(KEYS.escape);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes(PANEL));
    await w.answerElsewhere(q.id, "blue");
    w.wire.held[0]!.fail("the host broke");
    await screenShows(r, "Handled elsewhere");
    expect(statusLines(r).some((l) => l.includes("the host broke"))).toBe(
      false,
    );
  }, 60_000);
});
