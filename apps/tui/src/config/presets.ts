/**
 * Theme presets: whole themes a user picks by name with `theme.preset`. The four Catppuccin
 * flavours use the official palette (https://catppuccin.com/palette) as `#rrggbb`; the others, a
 * dark and a light of each, are the shared themes of @eta/client-contracts/themes, the same colours
 * as the client's palettes. They all need a terminal with true colour. `default` is not here: it is `DEFAULT_CONFIG.theme`, which follows the
 * terminal's own colours.
 */
import type { ThemeColors } from "@eta/client-contracts/themes";
import type { Theme } from "./types";
import { themes } from "@eta/client-contracts/themes";

/** The Catppuccin colours a theme takes; the others of the palette are not used. */
type Palette = Pick<
  ThemeColors,
  | "mauve"
  | "lavender"
  | "text"
  | "subtext0"
  | "surface2"
  | "red"
  | "yellow"
  | "green"
  | "sapphire"
  | "pink"
  | "teal"
>;

function palette(p: Palette): Theme {
  return {
    brand: p.mauve,
    brandDim: p.lavender,
    text: p.text,
    muted: p.subtext0,
    accent: p.sapphire,
    warning: p.yellow,
    error: p.red,
    success: p.green,
    border: p.surface2,
    selection: p.surface2,
    // No red or yellow (errors and warnings), no gray (muted lines, borders).
    agents: [p.sapphire, p.mauve, p.green, p.pink, p.teal, p.lavender],
  };
}

export const THEME_PRESETS = {
  "catppuccin-latte": palette({
    mauve: "#8839ef",
    lavender: "#7287fd",
    text: "#4c4f69",
    subtext0: "#6c6f85",
    surface2: "#acb0be",
    red: "#d20f39",
    yellow: "#df8e1d",
    green: "#40a02b",
    sapphire: "#209fb5",
    pink: "#ea76cb",
    teal: "#179299",
  }),
  "catppuccin-frappe": palette({
    mauve: "#ca9ee6",
    lavender: "#babbf1",
    text: "#c6d0f5",
    subtext0: "#a5adce",
    surface2: "#626880",
    red: "#e78284",
    yellow: "#e5c890",
    green: "#a6d189",
    sapphire: "#85c1dc",
    pink: "#f4b8e4",
    teal: "#81c8be",
  }),
  "catppuccin-macchiato": palette({
    mauve: "#c6a0f6",
    lavender: "#b7bdf8",
    text: "#cad3f5",
    subtext0: "#a5adcb",
    surface2: "#5b6078",
    red: "#ed8796",
    yellow: "#eed49f",
    green: "#a6da95",
    sapphire: "#7dc4e4",
    pink: "#f5bde6",
    teal: "#8bd5ca",
  }),
  "catppuccin-mocha": palette({
    mauve: "#cba6f7",
    lavender: "#b4befe",
    text: "#cdd6f4",
    subtext0: "#a6adc8",
    surface2: "#585b70",
    red: "#f38ba8",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    sapphire: "#74c7ec",
    pink: "#f5c2e7",
    teal: "#94e2d5",
  }),
  "dracula-dark": palette(themes.dracula.dark),
  "dracula-light": palette(themes.dracula.light),
  "nord-dark": palette(themes.nord.dark),
  "nord-light": palette(themes.nord.light),
  "gruvbox-dark": palette(themes.gruvbox.dark),
  "gruvbox-light": palette(themes.gruvbox.light),
  "tokyo-night-dark": palette(themes.tokyoNight.dark),
  "tokyo-night-light": palette(themes.tokyoNight.light),
  "solarized-dark": palette(themes.solarized.dark),
  "solarized-light": palette(themes.solarized.light),
  "rose-pine-dark": palette(themes.rosePine.dark),
  "rose-pine-light": palette(themes.rosePine.light),
  "one-dark": palette(themes.one.dark),
  "one-light": palette(themes.one.light),
} as const satisfies Record<string, Theme>;
