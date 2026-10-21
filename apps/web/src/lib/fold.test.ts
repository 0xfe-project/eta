import { beforeEach, describe, expect, it } from "@rstest/core";
import { foldChoice, rememberFold } from "./fold";

// What the reader left open, and how long the page remembers it.

const KEY = "eta.card-folds.v1";

beforeEach(() => {
  localStorage.setItem(KEY, "{}");
});

describe("a card's fold", () => {
  it("is unchosen until somebody says, and then it is said", () => {
    expect(foldChoice("row-a")).toBeUndefined();
    rememberFold("row-a", false);
    expect(foldChoice("row-a")).toBe(false);
    rememberFold("row-a", true);
    expect(foldChoice("row-a")).toBe(true);
  });

  it("survives the reload, because the answer is in storage and not in memory", () => {
    rememberFold("row-b", true);
    // What the page reads on the next load is whatever is in storage under that key.
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      "row-b": 1,
    });
  });

  it("reads a value it does not recognise as nothing said", () => {
    localStorage.setItem(KEY, "not json");
    expect(foldChoice("row-c")).toBeUndefined();
    localStorage.setItem(KEY, '{"row-c": "open"}');
    expect(foldChoice("row-c")).toBeUndefined();
  });

  it("forgets what it heard first once there are too many cards", () => {
    // The reader's opinion outlives the row it was about by a few hundred rows at most; past that,
    // the choices still kept are the ones a reload could plausibly be asked about.
    localStorage.setItem(
      KEY,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 500 }, (_, i) => [`old-${i}`, 1] as const),
        ),
      ),
    );
    rememberFold("row-new", false);
    expect(foldChoice("old-0")).toBeUndefined();
    expect(foldChoice("row-new")).toBe(false);
  });
});
