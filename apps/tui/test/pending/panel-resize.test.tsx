/**
 * The pending panel open while the terminal gets shorter: its lines take the new room, the frame
 * does not scroll as a whole, and ↓ moves only the cursor.
 */
import { describe, expect, it } from "vitest";
import { flush, KEYS, plain } from "../ui-support/render";
import { screenShows, twoRooms } from "./world";

/** The panel layer's rows under its title, border and padding off. */
function panelRows(screen: string): string[] {
  const lines = screen.split("\n");
  const title = lines.findIndex((line) =>
    line.includes("Waiting and conversations"),
  );
  const bottom = lines.findIndex(
    (line, index) => index > title && line.startsWith("└"),
  );
  return lines
    .slice(title + 1, bottom)
    .map((line) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trim());
}

/** The hint rows of the frame, under the title and above the footer, are empty. */
function expectFrameFits(screen: string) {
  const rows = panelRows(screen);
  expect(rows[0], screen).toBe("");
  expect(rows.at(-2), screen).toBe("");
}

describe("the pending panel when the terminal gets shorter", () => {
  it("fits the new height, and ↓ moves the cursor without scrolling the frame", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?", {
      choices: ["red", "blue"],
    });
    const r = await w.show(undefined, { rows: 30 });
    await r.press(KEYS.left);
    await screenShows(r, "Waiting and conversations");
    expectFrameFits(plain(r));
    r.stdout.resize(100, 12);
    for (let i = 0; i < 4; i += 1) await flush();
    expect(plain(r).trimEnd().split("\n").length).toBeLessThanOrEqual(12);
    expectFrameFits(plain(r));
    const before = panelRows(plain(r)).find((row) => row.startsWith("›"));
    expect(before).toBeDefined();
    await r.press(KEYS.down);
    expectFrameFits(plain(r));
    const after = panelRows(plain(r)).find((row) => row.startsWith("›"));
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  }, 90_000);
});
