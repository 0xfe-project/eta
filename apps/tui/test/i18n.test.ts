import { describe, expect, it } from "vitest";
import { chooseLocale } from "../src/i18n/locale";
import { fillPlaceholders, placeholdersOf } from "../src/i18n/messages";

describe("chooseLocale", () => {
  it("uses the setting when there is one, whatever the environment says", () => {
    expect(chooseLocale("en", { LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(chooseLocale("zh", { LANG: "en_US.UTF-8" })).toBe("zh");
  });

  it("takes the first non-empty of LC_ALL, LC_MESSAGES, LANG", () => {
    expect(
      chooseLocale(undefined, {
        LC_ALL: "zh_TW.UTF-8",
        LC_MESSAGES: "en_US",
        LANG: "en_US",
      }),
    ).toBe("zh");
    expect(
      chooseLocale(undefined, {
        LC_ALL: "",
        LC_MESSAGES: "zh_CN",
        LANG: "en_US",
      }),
    ).toBe("zh");
    expect(
      chooseLocale(undefined, { LC_ALL: "", LC_MESSAGES: "", LANG: "zh_CN" }),
    ).toBe("zh");
    // The first non-empty one decides, even when a later one says Chinese.
    expect(
      chooseLocale(undefined, { LC_ALL: "en_US.UTF-8", LANG: "zh_CN" }),
    ).toBe("en");
  });

  it("falls back to English for C, POSIX, unknown values and nothing at all", () => {
    expect(chooseLocale(undefined, { LANG: "C" })).toBe("en");
    expect(chooseLocale(undefined, { LANG: "POSIX" })).toBe("en");
    expect(chooseLocale(undefined, { LANG: "xx-garbage" })).toBe("en");
    expect(chooseLocale(undefined, { LANG: "de_DE.UTF-8" })).toBe("en");
    expect(chooseLocale(undefined, {})).toBe("en");
  });
});

describe("fillPlaceholders", () => {
  it("does not read substituted text as another placeholder", () => {
    expect(fillPlaceholders("{a}{b}", { a: "{b}", b: "B" })).toBe("{b}B");
  });
});

describe("placeholdersOf", () => {
  it("lists each placeholder name once, sorted", () => {
    expect(placeholdersOf("{b} {a} {b} plain {}")).toEqual(["a", "b"]);
  });
});
