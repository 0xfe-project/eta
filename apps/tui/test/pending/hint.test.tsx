/**
 * The conversation view's "waiting for your answer" line ends with the key that opens review
 * mode, as the settings bind it, and with nothing when it is unbound.
 */
import { describe, expect, it } from "vitest";
import { testConfig } from "../ui-support/config";
import { plain } from "../ui-support/render";
import { screenShows, twoRooms } from "./world";

/** The waiting line from its first word to its end, without the transcript's mark before it. */
function waitingLine(r: { lastFrame: () => string }): string {
  for (const line of plain(r).split("\n")) {
    const start = line.search(/Waiting for your answer|等你回答/);
    if (start !== -1) return line.slice(start).trim();
  }
  return "";
}

describe("the waiting line in a conversation", () => {
  it("ends with the review key from the settings", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?");
    const r = await w.showConversations([w.ben.group.id]);
    await screenShows(r, "Waiting for your answer: Which colour?");
    expect(waitingLine(r)).toBe(
      "Waiting for your answer: Which colour? (ctrl+r to answer)",
    );
  }, 60_000);

  it("has no key part when the key is unbound", async () => {
    const w = await twoRooms();
    await w.askIn("Ben", w.ben.group.id, "Which colour?");
    const base = testConfig();
    const r = await w.showConversations([w.ben.group.id], 0, {
      config: testConfig({
        keybindings: { ...base.keybindings, "review.open": [] },
      }),
    });
    await screenShows(r, "Waiting for your answer: Which colour?");
    expect(waitingLine(r)).toBe("Waiting for your answer: Which colour?");
  }, 60_000);
});
