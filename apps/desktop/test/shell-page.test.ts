import { describe, expect, it } from "vitest";
import { WORDS } from "../src/bun/shell-page";

const REASONS = [
  "address",
  "unreachable",
  "timeout",
  "not-eta",
  "token",
  "no-page",
  "lost",
  "host",
];

describe("the shell's words", () => {
  it("are the same keys in both languages", () => {
    expect(Object.keys(WORDS.en).toSorted()).toEqual(
      Object.keys(WORDS.zh).toSorted(),
    );
  });

  it.each(["zh", "en"] as const)(
    "say something for every failure in %s",
    (language) => {
      for (const reason of REASONS) {
        expect(WORDS[language]).toHaveProperty([`failure.${reason}.title`]);
        expect(WORDS[language]).toHaveProperty([`failure.${reason}.body`]);
      }
    },
  );
});
