/**
 * A waiting question taller than its layer: ↑ ↓ move the answer cursor and nothing else, the layer
 * keeps the cursor's row in view, and Enter sends the row the cursor is on.
 */
import { describe, expect, it } from "vitest";
import { until } from "../support/temp";
import { KEYS, plain } from "../ui-support/render";
import { askedFor, screenShows, twoRooms } from "./world";

/** The row the answer cursor is on, past its marker; undefined when it is out of view. */
function cursorRow(screen: string): string | undefined {
  return screen
    .split("\n")
    .map((line) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trim())
    .find((line) => line.startsWith("› "))
    ?.slice(2)
    .trim();
}

/** The question's lines on screen, each with its screen row, so a scroll shows as a change. */
function questionRows(screen: string): string[] {
  return screen
    .split("\n")
    .map(
      (line, row) =>
        `${row}:${line.replace(/^│ ?/, "").replace(/ ?│$/, "").trim()}`,
    )
    .filter((line) => /^\d+:Line \d+$/.test(line));
}

describe("a waiting question taller than its layer on a 20-row terminal", () => {
  it("moves the cursor one row per ↓, keeps it in view, and sends the row it is on", async () => {
    const w = await twoRooms();
    const text = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    const q = await w.askIn("Ben", w.ben.group.id, text, {
      choices: ["red", "blue"],
    });
    const r = await w.show(undefined, { rows: 20 });
    await r.press(KEYS.left);
    await screenShows(r, "Waiting and conversations");
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    await screenShows(r, () => cursorRow(plain(r)) !== undefined);
    expect(cursorRow(plain(r))).toBe("red");
    // blue is under the last row shown: the frame scrolls just enough to show it.
    await r.press(KEYS.down);
    expect(cursorRow(plain(r))).toBe("blue");
    const question = questionRows(plain(r));
    expect(question.length).toBeGreaterThan(0);
    // red is in view already: ↑ moves the cursor and nothing else, the question stays put.
    await r.press(KEYS.up);
    expect(cursorRow(plain(r))).toBe("red");
    expect(questionRows(plain(r))).toEqual(question);
    await r.press(KEYS.down);
    expect(cursorRow(plain(r))).toBe("blue");
    await r.press(KEYS.enter);
    await until(
      () => askedFor(w.wire, "inbox.answer").length > 0,
      10_000,
      "the answer",
    );
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["blue"] } },
    ]);
  }, 60_000);

  it("after PageUp took the cursor out of view, Enter brings it back and sends nothing; the next Enter sends", async () => {
    const w = await twoRooms();
    const text = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    const q = await w.askIn("Ben", w.ben.group.id, text, {
      choices: ["red", "blue"],
    });
    const r = await w.show(undefined, { rows: 20 });
    await r.press(KEYS.left);
    await screenShows(r, "Waiting and conversations");
    await r.press(KEYS.enter);
    await screenShows(r, "Ben · Ben room");
    await screenShows(r, () => cursorRow(plain(r)) !== undefined);
    await r.press("\u001B[5~");
    expect(cursorRow(plain(r))).toBeUndefined();
    await r.press(KEYS.enter);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(askedFor(w.wire, "inbox.answer")).toEqual([]);
    expect(cursorRow(plain(r))).toBe("red");
    await r.press(KEYS.enter);
    await until(
      () => askedFor(w.wire, "inbox.answer").length > 0,
      10_000,
      "the answer",
    );
    expect(askedFor(w.wire, "inbox.answer")).toEqual([
      { id: q.id, response: { kind: "selection", selections: ["red"] } },
    ]);
  }, 60_000);
});
