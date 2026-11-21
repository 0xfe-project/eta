import { themeIds, themes } from "@eta/client-contracts/themes";
import { expect, test } from "nsh/test";
import { paletteIds } from "../src/components/palettes";
import { palette } from "../src/components/theme";

test("every shared theme is a palette to choose", () => {
  for (const id of themeIds) expect(paletteIds).toContain(id);
});

test("a shared theme's palette takes its colors from the shared table, light and dark", () => {
  for (const id of themeIds) {
    for (const mode of ["light", "dark"] as const) {
      const c = palette(mode, id);
      const t = themes[id][mode];
      expect([
        c.canvas,
        c.surface,
        c.ink,
        c.muted,
        c.red,
        c.green,
        c.blue,
        c.button,
      ]).toEqual([
        t.base,
        t.mantle,
        t.text,
        t.subtext0,
        t.red,
        t.green,
        t.blue,
        t.mauve,
      ]);
    }
  }
});

test("a shared theme differs between light and dark", () => {
  for (const id of themeIds)
    expect(palette("light", id).canvas).not.toBe(palette("dark", id).canvas);
});
