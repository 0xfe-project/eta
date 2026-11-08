import type { KeyBinding } from "../../src/config/types";
import { describe, expect, it } from "vitest";
import { formatKeyBinding, parseKeyBinding } from "../../src/config/keys";
import { NAMED_KEYS } from "../../src/config/types";

const key = (
  name: string,
  mods: Partial<Pick<KeyBinding, "ctrl" | "alt" | "shift">> = {},
): KeyBinding => ({
  key: name,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
});

describe("parseKeyBinding", () => {
  it("reads a named key with modifiers", () => {
    expect(parseKeyBinding("alt+left")).toEqual(key("left", { alt: true }));
    expect(parseKeyBinding("ctrl+c")).toEqual(key("c", { ctrl: true }));
    expect(parseKeyBinding("escape")).toEqual(key("escape"));
  });

  it("takes up to three modifiers in any order", () => {
    const all = key("left", { ctrl: true, alt: true, shift: true });
    expect(parseKeyBinding("shift+alt+ctrl+left")).toEqual(all);
    expect(parseKeyBinding("alt+shift+ctrl+left")).toEqual(all);
    expect(parseKeyBinding("ctrl+alt+shift+left")).toEqual(all);
  });

  it("ignores case and lower-cases letters", () => {
    expect(parseKeyBinding("CTRL+Alt+LEFT")).toEqual(
      key("left", { ctrl: true, alt: true }),
    );
    expect(parseKeyBinding("Shift+R")).toEqual(key("r", { shift: true }));
    expect(parseKeyBinding("Q")).toEqual(key("q"));
  });

  it("accepts every named key", () => {
    for (const name of NAMED_KEYS)
      expect(parseKeyBinding(name)).toEqual(key(name));
  });

  it("accepts a printable character, including punctuation and the plus sign", () => {
    expect(parseKeyBinding("alt+1")).toEqual(key("1", { alt: true }));
    expect(parseKeyBinding("ctrl+/")).toEqual(key("/", { ctrl: true }));
    expect(parseKeyBinding("é")).toEqual(key("é"));
    expect(parseKeyBinding("+")).toEqual(key("+"));
    expect(parseKeyBinding("ctrl++")).toEqual(key("+", { ctrl: true }));
  });

  it("refuses what is not a binding", () => {
    for (const text of [
      "",
      "ctrl+ctrl+c",
      "alt+shift+alt+x",
      "ctrl",
      "ctrl+alt",
      "a+b",
      "left+right",
      "alt+lfet",
      "esc",
      " ",
      "alt+ ",
      "alt+\t",
      "ctrl+",
      "+a",
      "ctrl++a",
      " alt+left",
      "\u0007",
    ]) {
      expect(parseKeyBinding(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

describe("formatKeyBinding", () => {
  it("writes modifiers as ctrl, alt, shift, in lower case", () => {
    expect(
      formatKeyBinding(key("left", { shift: true, alt: true, ctrl: true })),
    ).toBe("ctrl+alt+shift+left");
    expect(formatKeyBinding(key("left", { ctrl: true, alt: true }))).toBe(
      "ctrl+alt+left",
    );
    expect(formatKeyBinding(key("r", { shift: true }))).toBe("shift+r");
    expect(formatKeyBinding(key("escape"))).toBe("escape");
  });

  it("reads back to the same binding", () => {
    const keys = [...NAMED_KEYS, "a", "1", "/", "+", "é"];
    for (const name of keys) {
      for (let mask = 0; mask < 8; mask += 1) {
        const binding = key(name, {
          ctrl: (mask & 1) !== 0,
          alt: (mask & 2) !== 0,
          shift: (mask & 4) !== 0,
        });
        expect(parseKeyBinding(formatKeyBinding(binding))).toEqual(binding);
      }
    }
  });
});
