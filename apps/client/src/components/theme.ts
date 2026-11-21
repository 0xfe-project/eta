import type { ViewStyle } from "nsh";
import { context } from "nsh";
import dwg from "../../assets/AKRDWGSCNFM-Regular.woff2";
import inter from "../../assets/InterVariable.woff2";

export const light = {
  canvas: "#ffffff",
  surface: "#fafafa",
  selected: "#f2f2f2",
  ink: "#111111",
  muted: "#6e6e6e",
  mutedInk: "#505050",
  faint: "#8c8c8c",
  border: "#e5e5e5",
  strong: "#cccccc",
  button: "#171717",
  buttonInk: "#ffffff",
  blue: "#006cb5",
  blueFill: "#e0eff8",
  green: "#008035",
  greenFill: "#e8f2eb",
  amber: "#a46700",
  amberFill: "#f7efdf",
  /** The design's state-warning: a warning's border or mark. */
  warning: "#c37000",
  /** The design's state-warning-ink: text on or beside a warning. */
  warningInk: "#955a00",
  red: "#c61623",
  redFill: "#fce9eb",
  /** The design's --color-ring: the keyboard focus ring. */
  ring: "#737373",
  shade: "#00000020",
  modalShade: "#0000001e",
  /** The foreground at 16%: the scrim of phone sheets, tablet drawers and
   * tablet dialogs. Desktop dialogs use `modalShade` (12%). */
  sheetShade: "#11111129",
  /** The design's --color-highlight: what a search matched, marked. */
  highlight: "#fae8a2",
};

const dark: typeof light = {
  canvas: "#0a0a0a",
  surface: "#090909",
  selected: "#161616",
  ink: "#fafafa",
  muted: "#a3a3a3",
  mutedInk: "#c5c5c5",
  faint: "#777777",
  border: "#292929",
  strong: "#4a4a4a",
  button: "#f5f5f5",
  buttonInk: "#101010",
  blue: "#65b7f0",
  blueFill: "#132a3b",
  green: "#52bb81",
  greenFill: "#16291e",
  amber: "#e0aa53",
  amberFill: "#302618",
  warning: "#de9300",
  warningInk: "#de9300",
  red: "#ff6874",
  redFill: "#3a1d21",
  ring: "#a1a1a1",
  shade: "#00000080",
  modalShade: "#00000048",
  sheetShade: "#0a0a0a99",
  highlight: "#635418",
};

export const Palette = context<() => typeof light>(() => light);

export const palette = (mode: "light" | "dark") =>
  mode === "dark" ? dark : light;

export function colors() {
  return Palette();
}

/** The design's keyboard focus: a 2px ring in `ring`, 2px outside the view.
 * Only keyboard focus shows it (`focusVisibleStyle`); a press shows none. */
export function focusRing(c: typeof light): ViewStyle {
  return { outlineWidth: 2, outlineColor: c.ring, outlineOffset: 2 };
}

export const row: ViewStyle = { flexDirection: "row", alignItems: "center" };

export const grow: ViewStyle = { flex: 1, minWidth: 0, minHeight: 0 };

export const fill: ViewStyle = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

/** The face the app ships, AKR DWG SC NFM (THIRD_PARTY_NOTICES.md), first in both stacks as
 * in the web app: interface text and monospace text alike. A font chosen in Appearance goes in
 * front of it (`fontFamily`). */
export const appFont = dwg;

const defaultFont = `${dwg}, ${inter}, system-ui, sans-serif`;

/** The fallback of every monospace surface: the shipped face, then the system's monospace. */
const defaultMonoFont = `${dwg}, ui-monospace, monospace`;

export const Fonts = context<() => { interface: string; mono: string }>(() => ({
  interface: "",
  mono: "",
}));

export function fontFamily(family: string, fallback = defaultFont) {
  if (!family.trim()) return fallback;
  return `${JSON.stringify(family.trim())}, ${fallback}`;
}

/** A monospace surface's stack: the monospace font chosen in Appearance, then the interface font
 * (an empty monospace setting follows it, as Settings says and as the web app does), then
 * `defaultMonoFont`. */
export function monoFontFamily(fonts: { interface: string; mono: string }) {
  return fontFamily(fonts.mono, fontFamily(fonts.interface, defaultMonoFont));
}

export const sizes = {
  sidebar: 288,
  tabletList: 320,
  rail: 64,
  panel: 400,
  header: 40,
  phoneNav: 64,
};

export type Layout = "desktop" | "tablet" | "phone";
