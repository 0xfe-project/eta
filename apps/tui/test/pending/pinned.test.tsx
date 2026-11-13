/**
 * The pending entry at the right end of the tab bar: its number follows the host, it asks for
 * attention while something waits, it opens the panel once, and a new item changes nothing else
 * on the screen.
 */
import { describe, expect, it } from "vitest";
import { KEYS, plain } from "../ui-support/render";
import { PENDING_KEYS, probe, screenShows, tabBar, twoRooms } from "./world";

const PANEL = "Waiting and conversations";

describe("the pending entry", () => {
  it("counts the questions and tasks waiting, and follows the host as they come and go", async () => {
    const w = await twoRooms();
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));

    const question = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));

    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
    );
    await screenShows(r, () => tabBar(r).endsWith("Pending 2"));

    await w.answerElsewhere(question.id, "red");
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));

    await w.moveTask(task.id, "blocked");
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));
    await w.moveTask(task.id, "done");
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
  }, 120_000);

  it("opens nothing, rings nothing and notifies nothing when a question comes", async () => {
    const w = await twoRooms();
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
    const before = plain(r).split("\n").slice(0, -1).join("\n");
    await w.askIn("Ben", w.ben.group.id, "Which colour?");
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));

    expect(plain(r)).not.toContain(PANEL);
    // Everything above the tab bar is as it was: the home screen and the status line.
    expect(plain(r).split("\n").slice(0, -1).join("\n")).toBe(before);
    const written = r.stdout.frames.join("");
    expect(written).not.toContain("\u0007");
    // Terminal notifications: OSC 9 and OSC 777.
    expect(written).not.toContain("\u001B]9;");
    expect(written).not.toContain("\u001B]777;");
  }, 60_000);

  it("opens the panel when selected, and selecting it again with the panel open opens no second one", async () => {
    const w = await twoRooms();
    const watch = probe();
    const r = await w.show(undefined, { extensions: [watch.extension] });
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));

    watch.ctx().selectPinnedTab("pending");
    await screenShows(r, PANEL);
    watch.ctx().selectPinnedTab("pending");
    await screenShows(r, PANEL);

    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes(PANEL));
  }, 60_000);
});

describe("the pending entry after the panel closed", () => {
  it("opens the panel again, however the panel was closed", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const watch = probe();
    const r = await w.show(undefined, { extensions: [watch.extension] });
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));

    // Closed with Esc: the entry and Left both open it again.
    watch.ctx().selectPinnedTab("pending");
    await screenShows(r, PANEL);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes(PANEL));
    watch.ctx().selectPinnedTab("pending");
    await screenShows(r, PANEL);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes(PANEL));
    await r.press(KEYS.left);
    await screenShows(r, PANEL);

    // Closed by going to the item's conversation from the item over it.
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    await r.press(PENDING_KEYS.openConversation);
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
    await screenShows(r, (s) => !s.includes(PANEL) && !s.includes("Decline"));
    watch.ctx().selectPinnedTab("pending");
    await screenShows(r, PANEL);

    // Closed by opening a conversation from it.
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes(PANEL));
    watch.ctx().selectPinnedTab("pending");
    await screenShows(r, PANEL);
  }, 90_000);
});

describe("what the pending entry counts", () => {
  it("counts no task that is to do, in progress or in the backlog", async () => {
    const w = await twoRooms();
    const first = await w.reviewTask("Ada", w.ada.group.id, "One", "One");
    const second = await w.reviewTask("Ada", w.ada.group.id, "Two", "Two");
    const third = await w.reviewTask("Ada", w.ada.group.id, "Three", "Three");
    const watch = probe();
    const r = await w.show(undefined, { extensions: [watch.extension] });
    await screenShows(r, () => tabBar(r).endsWith("Pending 3"));
    expect(watch.attention.at(-1)).toBe(true);

    await w.moveTask(first.id, "todo");
    await w.moveTask(second.id, "in_progress");
    await w.moveTask(third.id, "backlog");
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
    expect(watch.attention.at(-1)).toBe(false);
  }, 120_000);
});
