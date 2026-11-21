import { themeIds, themes } from "@eta/client-contracts/themes";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load";
import { THEME_PRESETS } from "../../src/config/presets";

const kebab = (id: string) =>
  id.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe("theme presets of the shared themes", () => {
  it("has a dark and a light of each, and the four Catppuccin", () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual(
      [
        "catppuccin-frappe",
        "catppuccin-latte",
        "catppuccin-macchiato",
        "catppuccin-mocha",
        ...themeIds.flatMap((id) => [
          `${kebab(id)}-dark`,
          `${kebab(id)}-light`,
        ]),
      ].sort(),
    );
  });

  for (const id of themeIds) {
    for (const mode of ["dark", "light"] as const) {
      const name = `${kebab(id)}-${mode}`;
      it(`resolves ${name} to the colours the client's palette uses`, () => {
        const c = themes[id][mode];
        const { config, problems } = parseConfig(
          JSON.stringify({ theme: { preset: name } }),
          "/conf/tui.json",
        );
        expect(problems).toEqual([]);
        expect(config.theme).toEqual({
          brand: c.mauve,
          brandDim: c.lavender,
          text: c.text,
          muted: c.subtext0,
          accent: c.sapphire,
          warning: c.yellow,
          error: c.red,
          success: c.green,
          border: c.surface2,
          selection: c.surface2,
          agents: [c.sapphire, c.mauve, c.green, c.pink, c.teal, c.lavender],
        });
      });
    }
  }
});
