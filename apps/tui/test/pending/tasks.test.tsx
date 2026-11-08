/**
 * `/tasks`: the open tasks in their order with their status, the count of closed ones, the empty
 * board, and what Enter opens for a task that waits and for one that does not.
 */
import { describe, expect, it } from "vitest";
import { KEYS, plain } from "../ui-support/render";
import { askedFor, PENDING_KEYS, screenShows, tabBar, twoRooms } from "./world";

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

const lineWith = (r: { lastFrame: () => string }, ...parts: string[]) =>
  lines(r).findIndex((line) => parts.every((part) => line.includes(part)));

describe("the /tasks command", () => {
  it("says there are no tasks on an empty board", async () => {
    const w = await twoRooms();
    const r = await w.show();
    await r.type("/tasks");
    await r.press(KEYS.enter);
    await screenShows(r, "No tasks yet");
    expect(plain(r)).not.toContain("more done or cancelled");
  }, 60_000);

  it("lists waiting tasks first, oldest first, then the rest newest first, and counts the closed ones", async () => {
    const w = await twoRooms();
    const review = await w.reviewTask("Ada", w.ada.group.id, "Ship it", "Ship");
    const blocked = await w.reviewTask("Ada", w.ada.group.id, "Fix it", "Fix");
    const plan = await w.reviewTask("Ada", w.ada.group.id, "Plan it", "Plan");
    const later = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Later it",
      "Later",
    );
    const done = await w.reviewTask("Ada", w.ada.group.id, "Old one", "Old");
    const dropped = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Dropped",
      "Drop",
    );
    await w.moveTask(blocked.id, "blocked");
    await w.moveTask(plan.id, "backlog");
    await w.moveTask(later.id, "backlog");
    await w.moveTask(done.id, "done");
    await w.moveTask(dropped.id, "cancelled");
    expect(review.number).toBe(1);

    const r = await w.show();
    await r.type("/tasks");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Ship it");
    const ship = lineWith(r, "#1 Ship it", "in review");
    const fix = lineWith(r, "#2 Fix it", "blocked");
    const laterLine = lineWith(r, "#4 Later it", "backlog");
    const planLine = lineWith(r, "#3 Plan it", "backlog");
    expect(ship).toBeGreaterThan(-1);
    expect(fix).toBeGreaterThan(ship);
    expect(laterLine).toBeGreaterThan(fix);
    expect(planLine).toBeGreaterThan(laterLine);
    expect(plain(r)).not.toContain("Old one");
    expect(plain(r)).not.toContain("Dropped");
    const closed = lineWith(
      r,
      "2 more done or cancelled (see the web or desktop app)",
    );
    expect(closed).toBeGreaterThan(planLine);
  }, 240_000);

  it("opens a task in review as a waiting item, and Esc goes back to the list", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask("Ada", w.ada.group.id, "Ship it", "Ship");
    const r = await w.show();
    await r.type("/tasks");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Ship it");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Ship it · in review");
    expect(plain(r)).toContain("Accept (mark done)");
    await r.press(KEYS.escape);
    await screenShows(
      r,
      (s) => s.includes("#1 Ship it") && !s.includes("Accept"),
    );
    await r.press(KEYS.enter);
    await screenShows(r, "Accept (mark done)");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes("Accept"));
    expect(askedFor(w.wire, "tasks.update")).toEqual([
      { taskId: task.id, status: "done" },
    ]);
  }, 90_000);

  it("opens any other task to read and comment on, and goes to its conversation", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Plan it",
      "Plan the work",
      "Here is the plan.",
    );
    await w.moveTask(task.id, "backlog");
    const r = await w.show();
    await r.type("/tasks");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Plan it");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Plan it · backlog");
    await screenShows(r, "Plan the work");
    await screenShows(r, "Here is the plan.");
    expect(plain(r)).toContain("Comment…");
    expect(plain(r)).not.toContain("Accept (mark done)");
    expect(plain(r)).toContain("alt+o");

    await r.type("noted");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes("Comment…"));
    expect(askedFor(w.wire, "tasks.comment")).toEqual([
      expect.objectContaining({ taskId: task.id, body: "noted" }),
    ]);

    await r.press(KEYS.enter);
    await screenShows(r, "#1 Plan it · backlog");
    await r.press(PENDING_KEYS.openConversation);
    await screenShows(r, () => tabBar(r).includes("1:Ada room"));
    await screenShows(r, (s) => !s.includes("#1 Plan it"));
  }, 90_000);
});

describe("a blocked task from /tasks", () => {
  it("opens as a waiting item to reply to", async () => {
    const w = await twoRooms();
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Fix it",
      "Fix",
      "Which branch?",
    );
    await w.moveTask(task.id, "blocked");
    const r = await w.show();
    await r.type("/tasks");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Fix it");
    await r.press(KEYS.enter);
    await screenShows(r, "#1 Fix it · blocked");
    expect(plain(r)).toContain("Reply…");
    expect(plain(r)).not.toContain("Comment…");
    await r.type("main");
    await r.press(KEYS.enter);
    await screenShows(r, (s) => !s.includes("Reply…"));
    expect(askedFor(w.wire, "tasks.comment")).toEqual([
      expect.objectContaining({ taskId: task.id, body: "main" }),
    ]);
  }, 90_000);
});
