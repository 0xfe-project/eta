import { describe, expect, it } from "vitest";
import { themeIds, themes } from "../src/themes";

const roles = [
  "base",
  "mantle",
  "surface0",
  "surface2",
  "overlay1",
  "overlay2",
  "subtext0",
  "subtext1",
  "text",
  "red",
  "peach",
  "yellow",
  "green",
  "teal",
  "sapphire",
  "blue",
  "mauve",
  "lavender",
  "pink",
];

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

describe("shared themes", () => {
  it("lists the themes the client and the TUI offer", () => {
    expect([...themeIds]).toEqual([
      "dracula",
      "nord",
      "gruvbox",
      "tokyoNight",
      "solarized",
      "rosePine",
      "one",
    ]);
    expect(Object.keys(themes).sort()).toEqual([...themeIds].sort());
  });

  for (const id of themeIds) {
    for (const mode of ["dark", "light"] as const) {
      it(`gives ${id} ${mode} every role as #rrggbb`, () => {
        const colors = themes[id][mode];
        expect(Object.keys(colors).sort()).toEqual([...roles].sort());
        for (const value of Object.values(colors))
          expect(value).toMatch(/^#[0-9a-f]{6}$/);
      });

      it(`keeps ${id} ${mode} text apart from its canvas in the right direction`, () => {
        const { base, text } = themes[id][mode];
        const gap = luminance(text) - luminance(base);
        expect(mode === "dark" ? gap : -gap).toBeGreaterThan(60);
      });
    }
  }
});
