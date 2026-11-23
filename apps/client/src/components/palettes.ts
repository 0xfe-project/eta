import type { ThemeColors, ThemeId } from "@eta/client-contracts/themes";
import type { light } from "./theme";
import { themeIds, themes } from "@eta/client-contracts/themes";

export const paletteIds = ["default", "catppuccin", ...themeIds] as const;
export type PaletteId = (typeof paletteIds)[number];

export const flavors = ["frappe", "macchiato", "mocha"] as const;
export type Flavor = (typeof flavors)[number];

type Colors = typeof light;

interface Flavored {
  base: string;
  mantle: string;
  surface0: string;
  surface1: string;
  surface2: string;
  overlay1: string;
  overlay2: string;
  subtext0: string;
  subtext1: string;
  text: string;
  blue: string;
  green: string;
  yellow: string;
  peach: string;
  red: string;
  mauve: string;
}

// The official Catppuccin palettes (https://catppuccin.com/palette).
const latte: Flavored = {
  base: "#eff1f5",
  mantle: "#e6e9ef",
  surface0: "#ccd0da",
  surface1: "#bcc0cc",
  surface2: "#acb0be",
  overlay1: "#8c8fa1",
  overlay2: "#7c7f93",
  subtext0: "#6c6f85",
  subtext1: "#5c5f77",
  text: "#4c4f69",
  blue: "#1e66f5",
  green: "#40a02b",
  yellow: "#df8e1d",
  peach: "#fe640b",
  red: "#d20f39",
  mauve: "#8839ef",
};

const dark: Record<Flavor, Flavored> = {
  frappe: {
    base: "#303446",
    mantle: "#292c3c",
    surface0: "#414559",
    surface1: "#51576d",
    surface2: "#626880",
    overlay1: "#838ba7",
    overlay2: "#949cbb",
    subtext0: "#a5adce",
    subtext1: "#b5bfe2",
    text: "#c6d0f5",
    blue: "#8caaee",
    green: "#a6d189",
    yellow: "#e5c890",
    peach: "#ef9f76",
    red: "#e78284",
    mauve: "#ca9ee6",
  },
  macchiato: {
    base: "#24273a",
    mantle: "#1e2030",
    surface0: "#363a4f",
    surface1: "#494d64",
    surface2: "#5b6078",
    overlay1: "#8087a2",
    overlay2: "#939ab7",
    subtext0: "#a5adcb",
    subtext1: "#b8c0e0",
    text: "#cad3f4",
    blue: "#8aadf4",
    green: "#a6da95",
    yellow: "#eed49f",
    peach: "#f5a97f",
    red: "#ed8796",
    mauve: "#c6a0f6",
  },
  mocha: {
    base: "#1e1e2e",
    mantle: "#181825",
    surface0: "#313244",
    surface1: "#45475a",
    surface2: "#585b70",
    overlay1: "#7f849c",
    overlay2: "#9399b2",
    subtext0: "#a6adc8",
    subtext1: "#bac2de",
    text: "#cdd6f4",
    blue: "#89b4fa",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    peach: "#fab387",
    red: "#f38ba8",
    mauve: "#cba6f7",
  },
};

/** `color` over `base` at `amount` (0..1), as #rrggbb. */
function mix(color: string, base: string, amount: number) {
  const channel = (hex: string, at: number) =>
    Number.parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5]
    .map((at) =>
      Math.round(channel(color, at) * amount + channel(base, at) * (1 - amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function colors(
  f: Omit<Flavored, "surface1">,
  scrims: Pick<Colors, "scrim" | "sheetScrim">,
): Colors {
  const fill = (color: string) => mix(color, f.base, 0.15);
  const selected = f.surface0;
  return {
    canvas: f.base,
    surface: f.mantle,
    selected,
    ink: f.text,
    muted: f.subtext0,
    mutedInk: f.subtext1,
    faint: f.overlay1,
    border: f.surface0,
    strong: f.surface2,
    button: f.mauve,
    buttonInk: f.base,
    blue: f.blue,
    blueFill: fill(f.blue),
    green: f.green,
    greenFill: fill(f.green),
    // What was amber: the warning that reads (a status, a line of text) is yellow; its ink and the
    // warning bar's line stay peach.
    warning: f.yellow,
    warningInk: f.peach,
    warningFill: fill(f.yellow),
    warningLine: `${f.peach}66`,
    red: f.red,
    redFill: fill(f.red),
    ring: f.overlay2,
    selectedSoft: `${selected}80`,
    overlay: `${f.text}08`,
    ...scrims,
    highlight: mix(f.yellow, f.base, 0.35),
  };
}

export const catppuccin = {
  light: colors(latte, {
    scrim: "#0000001e",
    sheetScrim: "#4c4f6929",
  }),
  dark: Object.fromEntries(
    flavors.map((name) => [
      name,
      colors(dark[name], {
        scrim: "#00000048",
        sheetScrim: `${dark[name].base}99`,
      }),
    ]),
  ) as Record<Flavor, Colors>,
};

/** The shared themes (@eta/client-contracts/themes): each has a light and a dark palette. */
export const shared = Object.fromEntries(
  themeIds.map((id) => [id, sharedTheme(themes[id])]),
) as Record<ThemeId, { light: Colors; dark: Colors }>;

function sharedTheme(t: { light: ThemeColors; dark: ThemeColors }) {
  return {
    light: colors(t.light, {
      scrim: "#0000001e",
      sheetScrim: `${t.light.text}29`,
    }),
    dark: colors(t.dark, {
      scrim: "#00000048",
      sheetScrim: `${t.dark.base}99`,
    }),
  };
}
