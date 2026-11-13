/**
 * Review mode: every waiting item in turn, oldest first, in one layer; skipping, items that come
 * or go meanwhile, how it ends, Esc, and going to an item's conversation.
 */
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { until } from "../support/temp";
import { KEYS, plain, realDelay } from "../ui-support/render";
import { askedFor, PENDING_KEYS, screenShows, tabBar, twoRooms } from "./world";

const noReview = (s: string) => !s.includes("Review ·");

describe("review mode", () => {
  it("does not open when nothing waits, and says so", async () => {
    const w = await twoRooms();
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Nothing is waiting");
    expect(plain(r)).not.toContain("Review ·");
  }, 60_000);

  it("goes through the items oldest first, one after another, and says when all are done", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const task = await w.reviewTask(
      "Ada",
      w.ada.group.id,
      "Ship it",
      "Make the release",
    );
    const r = await w.showConversations([w.ada.group.id]);
    await screenShows(r, () => tabBar(r).endsWith("Pending 2"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 2 left");
    expect(plain(r)).toContain("Which colour?");
    expect(plain(r)).toContain("Ben · Ben room");

    await r.press(KEYS.enter);
    await screenShows(r, "Review · 1 left");
    await screenShows(r, "#1 Ship it · in review");
    expect(plain(r)).not.toContain("Which colour?");

    await r.press(KEYS.enter);
    await screenShows(r, "All caught up");
    await screenShows(r, noReview);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["red"] } },
    ]);
    expect(askedFor(w.wire, "tasks.update")).toEqual([
      { taskId: task.id, status: "done" },
    ]);
    // The user stayed where they were.
    expect(tabBar(r)).toContain("1:Ada room");
  }, 120_000);

  it("skips with Tab, and closes saying the rest was skipped when only skipped items are left", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "First?");
    await w.askIn("Ada", w.ada.group.id, "Second?");
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 2"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 2 left");
    expect(plain(r)).toContain("First?");
    await r.press(KEYS.tab);
    await screenShows(r, "Review · 1 left");
    expect(plain(r)).toContain("Second?");
    expect(plain(r)).not.toContain("First?");
    await r.press(KEYS.tab);
    await screenShows(r, "Skipped the rest");
    await screenShows(r, noReview);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
    // Skipping is for this review only: the next one starts from the oldest again.
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 2 left");
    expect(plain(r)).toContain("First?");
  }, 90_000);

  it("leaves with Esc without answering", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "First?");
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 1 left");
    await r.press(KEYS.escape);
    await screenShows(r, noReview);
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
    expect(tabBar(r).endsWith("Pending 1")).toBe(true);
  }, 60_000);

  it("takes in an item that comes meanwhile, in its turn", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "First?", { choices: ["yes", "no"] });
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 1 left");
    await w.askIn("Ada", w.ada.group.id, "Second?", { choices: ["a", "b"] });
    await screenShows(r, "Review · 2 left");
    expect(plain(r)).toContain("First?");
    await r.press(KEYS.enter);
    await screenShows(r, "Second?");
    expect(plain(r)).toContain("Review · 1 left");
  }, 90_000);

  it("moves on when the current item is handled elsewhere, saying so", async () => {
    const w = await twoRooms();
    const first = await w.askIn("Ben", w.ben.group.id, "First?");
    await w.askIn("Ada", w.ada.group.id, "Second?");
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 2"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "First?");
    await w.answerElsewhere(first.id);
    await screenShows(r, "Second?");
    await screenShows(r, "Handled elsewhere");
    expect(plain(r)).toContain("Review · 1 left");
  }, 90_000);

  it("goes to the current item's conversation and leaves review mode", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "First?");
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 1 left");
    await r.press(PENDING_KEYS.openConversation);
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
    await screenShows(r, noReview);
    await until(() => !plain(r).includes("Decline"));
  }, 60_000);
});

describe("an answer that lands after review mode was left", () => {
  it("says nothing about review mode ending, left with Esc", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "First?", {
      choices: ["yes", "no"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 1 left");
    await r.press(KEYS.enter);
    await r.press(KEYS.escape);
    await screenShows(r, noReview);
    w.wire.held[0]!.release();
    await until(() => w.interaction(q.id)?.status === "answered");
    await screenShows(r, () => tabBar(r).endsWith("Pending 0"));
    await realDelay(200);
    const shown = r.stdout.frames.map((frame) =>
      stripVTControlCharacters(frame),
    );
    expect(shown.some((frame) => frame.includes("All caught up"))).toBe(false);
  }, 60_000);

  it("says nothing about review mode ending, left for the conversation", async () => {
    const w = await twoRooms();
    const q = await w.askIn("Ben", w.ben.group.id, "First?", {
      choices: ["yes", "no"],
    });
    w.wire.holding.add("inbox.answer");
    const r = await w.show();
    await screenShows(r, () => tabBar(r).endsWith("Pending 1"));
    await r.press(PENDING_KEYS.review);
    await screenShows(r, "Review · 1 left");
    await r.press(KEYS.enter);
    await r.press(PENDING_KEYS.openConversation);
    await screenShows(r, () => tabBar(r).includes("1:Ben room"));
    w.wire.held[0]!.release();
    await until(() => w.interaction(q.id)?.status === "answered");
    await realDelay(200);
    const shown = r.stdout.frames.map((frame) =>
      stripVTControlCharacters(frame),
    );
    expect(shown.some((frame) => frame.includes("All caught up"))).toBe(false);
  }, 60_000);
});
