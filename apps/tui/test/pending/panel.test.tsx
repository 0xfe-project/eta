/**
 * The panel of waiting items and conversations: what each line says and in what order, moving
 * through it and scrolling, what Enter does on each kind of line, and Esc.
 */
import { describe, expect, it } from "vitest";
import { HANG } from "../../../eta/test/support/models";
import { until } from "../support/temp";
import { KEYS, plain } from "../ui-support/render";
import {
  askedFor,
  PENDING_KEYS,
  pendingWorld,
  screenShows,
  tabBar,
  twoRooms,
} from "./world";

const PANEL = "Waiting and conversations";

/** The screen's lines, each trimmed of the layer's border and padding. */
function lines(r: { lastFrame: () => string }): string[] {
  return plain(r)
    .split("\n")
    .map((line) =>
      line
        .replace(/^[│|]\s?/, "")
        .replace(/\s?[│|]\s*$/, "")
        .trim(),
    );
}

/** The index of the first line that contains every one of `parts`; -1 when none does. */
function lineWith(r: { lastFrame: () => string }, ...parts: string[]): number {
  return lines(r).findIndex((line) =>
    parts.every((part) => line.includes(part)),
  );
}

/** The line the panel's cursor is on. */
function marked(r: { lastFrame: () => string }): string {
  return lines(r).find((line) => line.startsWith("›")) ?? "";
}

describe("the panel's lines", () => {
  it("lists what waits oldest first, then the conversations not archived by their last message, newest first", async () => {
    const w = await twoRooms();
    // Cy answers nothing and keeps working: her conversation is running.
    const cy = await w.room("Cy", "Cy room");
    w.behaviours.set("Cy", () => HANG);
    await w.send(cy.group.id, "start");
    await until(
      () =>
        w
          .conversations()
          .find((c) => c.id === cy.group.id)
          ?.participants.some((p) => p.status === "working") === true,
      20_000,
      "Cy working",
    );
    const shelf = await w.room("Dee", "Shelved room");
    await w.ask("conversations", "update", {
      conversationId: shelf.group.id,
      archived: true,
    });

    await w.askIn("Ben", w.ben.group.id, "Which colour?\nSecond line", {
      choices: ["red", "blue"],
    });
    await w.reviewTask("Ada", w.ada.group.id, "Ship it", "Make the release");
    await w.askIn("Ada", w.ada.group.id, "Which size?");

    const r = await w.showConversations([w.ben.group.id]);
    await screenShows(r, () => tabBar(r).endsWith("Pending 3"));
    await r.press(KEYS.left);
    await screenShows(r, PANEL);

    const benQuestion = lineWith(r, "? Ben · Ben room", "Which colour?");
    const task = lineWith(r, "#1 Ship it", "in review");
    const adaQuestion = lineWith(r, "? Ada · Ada room", "Which size?");
    expect(benQuestion).toBeGreaterThan(-1);
    expect(lines(r)[benQuestion]).not.toContain("Second line");
    expect(task).toBeGreaterThan(benQuestion);
    expect(adaQuestion).toBeGreaterThan(task);
    expect(lineWith(r, "Waiting")).toBeLessThan(benQuestion);

    const heading = lines(r).findIndex((line) => line === "Conversations");
    const ada = lineWith(r, "Ada room", "!");
    const ben = lineWith(r, "Ben room", "!", "[1]");
    const cyLine = lineWith(r, "Cy room", "●");
    expect(heading).toBeGreaterThan(adaQuestion);
    expect(ada).toBeGreaterThan(heading);
    expect(ben).toBeGreaterThan(ada);
    expect(cyLine).toBeGreaterThan(ben);
    expect(plain(r)).not.toContain("Shelved room");
    // A conversation not open as a tab has no tab number.
    expect(lines(r)[ada]).not.toMatch(/\[\d\]/);

    for (const id of [w.ada.group.id, w.ben.group.id, cy.group.id]) {
      const summary = w.conversations().find((c) => c.id === id)!;
      const row = lines(r).findIndex(
        (line, index) => index > heading && line.includes(summary.name),
      );
      if (summary.unread > 0)
        expect(lines(r)[row]).toContain(`${summary.unread} new`);
      else expect(lines(r)[row]).not.toMatch(/\d+ new/);
    }
  }, 180_000);

  it("says how to start when there is nothing waiting and no conversation", async () => {
    const w = await pendingWorld();
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    expect(plain(r)).toContain("No conversations yet. Start one with /new");
    expect(plain(r)).not.toContain("Waiting\n");
  }, 60_000);
});

describe("enter and Esc in the panel", () => {
  it("opens a conversation as a tab and closes the panel", async () => {
    const w = await twoRooms();
    await w.send(w.ada.group.id, "newest");
    const r = await w.show();
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    // Nothing waits: the cursor starts on the newest conversation.
    expect(marked(r)).toContain("Ada room");
    await r.press(KEYS.down);
    expect(marked(r)).toContain("Ben room");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes(PANEL));
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
  }, 60_000);

  it("opens a waiting item over the panel; Esc goes back to the panel, and Esc again closes it", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const r = await w.show();
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    expect(marked(r)).toContain("Which colour?");
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    expect(plain(r)).toContain("Decline");
    expect(plain(r)).not.toContain(PANEL);

    await r.press(KEYS.escape);
    await screenShows(r, PANEL);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes(PANEL));
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
    // Nothing opened as a tab.
    expect(tabBar(r).startsWith("1:")).toBe(false);
  }, 60_000);
});

describe("a long panel", () => {
  it("scrolls with the cursor, a line or a screen at a time", async () => {
    const w = await pendingWorld();
    const owner = await w.agent("Owner");
    const place = await w.project(owner.id);
    const names: string[] = [];
    for (let i = 1; i <= 16; i += 1) {
      const name = `Room ${String(i).padStart(2, "0")}`;
      names.push(name);
      await w.conversation(place.id, [owner.id], name);
    }
    // Newest first: the room made last is at the top.
    const order = [...names].reverse();
    const r = await w.show(undefined, { rows: 14 });
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    expect(plain(r)).toContain(order[0]);
    expect(plain(r)).not.toContain(order[15]);

    for (let i = 0; i < 15; i += 1) await r.press(KEYS.down);
    expect(marked(r)).toContain(order[15]);
    expect(plain(r)).not.toContain(order[0]);

    await r.press(PENDING_KEYS.pageUp);
    await r.press(PENDING_KEYS.pageUp);
    await r.press(PENDING_KEYS.pageUp);
    expect(marked(r)).toContain(order[0]);

    await r.press(PENDING_KEYS.pageDown);
    const after = marked(r);
    const index = order.findIndex((name) => after.includes(name));
    // A screen down is more than one line and the cursor stays on screen.
    expect(index).toBeGreaterThan(1);
    expect(plain(r)).not.toContain(`› ${order[0]}`);
  }, 120_000);
});

describe("lines that come while the panel is open", () => {
  it("leave the cursor on the line it was on, and Enter opens that one", async () => {
    const w = await twoRooms();
    await w.send(w.ada.group.id, "newest");
    const r = await w.show();
    await r.press(KEYS.left);
    await screenShows(r, PANEL);
    expect(marked(r)).toContain("Ada room");
    await r.press(KEYS.down);
    expect(marked(r)).toContain("Ben room");

    // A question puts the waiting heading and its line above the cursor.
    await w.askIn("Ada", w.ada.group.id, "Which size?");
    await screenShows(r, "Which size?");
    expect(marked(r)).toContain("Ben room");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes(PANEL));
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
  }, 60_000);
});
