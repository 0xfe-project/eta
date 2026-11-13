/**
 * A reply's steps folded on a real host: the model calls two tools and then answers, and the
 * conversation shows one line for the calls while the reply works and after it ends, unfolding
 * and folding with the toggle key.
 */
import { describe, expect, it, vi } from "vitest";
import { call, gate, say } from "../../../eta/test/support/models";
import { KEYS, plain } from "../ui-support/render";
import { screenShows, withAda } from "./view-host-world";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

describe("a reply that calls tools", () => {
  it("folds its calls into one line while it works and once it is done, and unfolds on the toggle key", async () => {
    const answer = gate();
    const world = await withAda(async (request) => {
      if (request.index === 0) return call("not_a_tool", { what: "first" });
      if (request.index === 1) return call("not_a_tool", { what: "second" });
      await answer.opened;
      return say("all done");
    });
    const r = await world.showConversation(world.group.id);
    await screenShows(r, "Write a message");
    await world.send(world.group.id, "go");

    await screenShows(r, "▸ Working (2 tools so far)");
    expect(plain(r)).not.toContain("not_a_tool");

    answer.open();
    await screenShows(r, "all done");
    await screenShows(r, "▸ Used 2 tools, 2 failed");
    expect(plain(r)).not.toContain("not_a_tool");

    await r.press(KEYS.alt("e"));
    await screenShows(r, "▾ Used 2 tools, 2 failed");
    await screenShows(r, "not_a_tool first");
    expect(plain(r)).toContain("not_a_tool second");
    expect(plain(r)).toContain("all done");

    await r.press(KEYS.alt("e"));
    await screenShows(r, "▸ Used 2 tools, 2 failed");
    expect(plain(r)).not.toContain("not_a_tool");
  }, 60_000);

  it("names the tool call that is running, by its card's title, while it waits", async () => {
    // `ask_user` runs until the user answers, so the reply stays on it.
    const world = await withAda(async (request) => {
      if (request.index === 0) return call("not_a_tool", { what: "first" });
      return call("ask_user", {
        question: "Which colour?",
        options: [{ title: "red" }, { title: "blue" }],
      });
    });
    const r = await world.showConversation(world.group.id);
    await screenShows(r, "Write a message");
    await world.send(world.group.id, "go");

    await screenShows(r, "▸ Running: ask_user Which colour? (2 so far)");
    expect(plain(r)).not.toContain("not_a_tool");
  }, 60_000);
});
