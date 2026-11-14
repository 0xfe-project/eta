import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act, createElement } from "react";
import { cleanup, mount } from "@/test-render";
import { useFold } from "./fold";

// What the reader left open, and how long the page remembers it — through the hook the cards use.

const KEY = "eta.card-folds.v1";

/** One card's fold, drawn; `open()` reads it and `fold()` is the reader's click. */
async function card(id: string, defaultOpen: boolean) {
  let state: ReturnType<typeof useFold> = [defaultOpen, () => {}];
  function Card() {
    state = useFold(id, defaultOpen);
    return null;
  }
  await mount(createElement(Card));
  return {
    open: () => state[0],
    fold: (open: boolean) => act(async () => state[1](open)),
  };
}

beforeEach(() => {
  localStorage.setItem(KEY, "{}");
});
afterEach(cleanup);

describe("a card's fold", () => {
  it("follows its default until somebody says, and then it is said", async () => {
    const row = await card("row-a", true);
    expect(row.open()).toBe(true);
    await row.fold(false);
    expect(row.open()).toBe(false);
    await row.fold(true);
    expect(row.open()).toBe(true);
  });

  it("survives the reload, because the answer is in storage and not in memory", async () => {
    await (await card("row-b", false)).fold(true);
    // What the page reads on the next load is whatever is in storage under that key.
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      "row-b": 1,
    });
    expect((await card("row-b", false)).open()).toBe(true);
  });

  it("reads a value it does not recognise as nothing said", async () => {
    localStorage.setItem(KEY, "not json");
    expect((await card("row-c", true)).open()).toBe(true);
    localStorage.setItem(KEY, '{"row-c": "open"}');
    expect((await card("row-c", true)).open()).toBe(true);
  });

  it("forgets what it heard first once there are too many cards", async () => {
    // The reader's opinion outlives the row it was about by a few hundred rows at most; past that,
    // the choices still kept are the ones a reload could plausibly be asked about.
    localStorage.setItem(
      KEY,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 500 }, (_, i) => [`old-${i}`, 0] as const),
        ),
      ),
    );
    await (await card("row-new", true)).fold(false);
    expect((await card("old-0", true)).open()).toBe(true);
    expect((await card("old-1", true)).open()).toBe(false);
    expect((await card("row-new", true)).open()).toBe(false);
  });
});
