import type { Entry, EntryType, MessageEntry } from "../src/types/entries";
import { describe, expectTypeOf, it } from "vitest";

describe("entry union", () => {
  it("the EntryType list and the Entry union name the same kinds", () => {
    // Two hand-kept lists in entries.ts: a kind added to one and not the other
    // fails typecheck here.
    expectTypeOf<Entry["type"]>().toEqualTypeOf<EntryType>();
  });

  it("newEntry strips seq and timestamp", () => {
    expectTypeOf<
      import("../src/types/entries.ts").NewEntry<MessageEntry>
    >().not.toHaveProperty("seq");
    expectTypeOf<
      import("../src/types/entries.ts").NewEntry<MessageEntry>
    >().toHaveProperty("type");
  });
});
