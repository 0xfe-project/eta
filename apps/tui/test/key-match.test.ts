import type { Key } from "ink";
import type { KeyBinding } from "../src/config/types";
import { describe, expect, it } from "vitest";
import { matchesBinding } from "../src/ui/key-match";

function key(flags: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...flags,
  };
}

function binding(
  name: string,
  mods: Partial<Omit<KeyBinding, "key">> = {},
): KeyBinding {
  return { key: name, ctrl: false, alt: false, shift: false, ...mods };
}

describe("matchesBinding", () => {
  it("matches alt+left only with Alt held", () => {
    const altLeft = binding("left", { alt: true });
    expect(
      matchesBinding(altLeft, "", key({ leftArrow: true, meta: true })),
    ).toBe(true);
    expect(matchesBinding(altLeft, "", key({ leftArrow: true }))).toBe(false);
    expect(
      matchesBinding(binding("left"), "", key({ leftArrow: true, meta: true })),
    ).toBe(false);
  });

  it("matches ctrl+c by the letter Ink reports with ctrl", () => {
    const ctrlC = binding("c", { ctrl: true });
    expect(matchesBinding(ctrlC, "c", key({ ctrl: true }))).toBe(true);
    expect(matchesBinding(ctrlC, "c", key())).toBe(false);
    expect(matchesBinding(ctrlC, "d", key({ ctrl: true }))).toBe(false);
  });

  it("matches alt+digit", () => {
    expect(
      matchesBinding(binding("3", { alt: true }), "3", key({ meta: true })),
    ).toBe(true);
    expect(
      matchesBinding(binding("3", { alt: true }), "4", key({ meta: true })),
    ).toBe(false);
  });

  it("keeps shift apart: a binding for a does not fire on A", () => {
    expect(matchesBinding(binding("a"), "A", key({ shift: true }))).toBe(false);
    expect(
      matchesBinding(binding("a", { shift: true }), "A", key({ shift: true })),
    ).toBe(true);
    expect(matchesBinding(binding("a"), "a", key())).toBe(true);
  });

  it.each([
    ["escape", { escape: true }, ""],
    ["enter", { return: true }, "\r"],
    ["tab", { tab: true }, ""],
    ["backspace", { backspace: true }, ""],
    ["delete", { delete: true }, ""],
    ["up", { upArrow: true }, ""],
    ["down", { downArrow: true }, ""],
    ["right", { rightArrow: true }, ""],
    ["pageup", { pageUp: true }, ""],
    ["pagedown", { pageDown: true }, ""],
    ["home", { home: true }, ""],
    ["end", { end: true }, ""],
    ["space", {}, " "],
  ] as const)(
    "matches the named key %s and nothing else",
    (name, flags, input) => {
      expect(matchesBinding(binding(name), input, key(flags))).toBe(true);
      expect(matchesBinding(binding(name), "x", key())).toBe(false);
    },
  );
});
