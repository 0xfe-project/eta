import type { Theme, ThemeToken } from "../../../config/types";
import type { Translate } from "../../../i18n/messages";
import type { Palette } from "../../../ui/gemini/colors";
import type { RenderOptions } from "../contract";
import type { Lines } from "./lines";
import type { RenderMessageKey } from "./messages";
import { translatorFor } from "../../../i18n/messages";
import { inkColor } from "../../../ui/theme";
import { renderMessages } from "./messages";

/** The theme as Ink colours; `undefined` is the terminal's own colour. */
export type Colors = Record<ThemeToken, string | undefined>;

/** What drawing one item needs besides the item. */
export interface DrawContext {
  width: number;
  previewLines: number;
  expanded: boolean;
  colors: Colors;
  /** The colours the components from Gemini CLI paint with. */
  palette: Palette;
  t: Translate<RenderMessageKey>;
}

/** One item drawn, before the lines are split into the two arrays the contract names. */
export interface DrawnItem {
  lines: Lines;
  source: string;
  foldable: boolean;
}

export function contextFor(options: RenderOptions): DrawContext {
  const colors = colorsOf(options.theme);
  return {
    width: options.width,
    previewLines: options.previewLines,
    expanded: options.expanded,
    colors,
    palette: {
      text: colors.text,
      muted: colors.muted,
      accent: colors.accent,
      border: colors.border,
      success: colors.success,
      error: colors.error,
    },
    t: translatorFor(renderMessages, options.locale),
  };
}

function colorsOf(theme: Theme): Colors {
  const entries = Object.entries(theme) as [ThemeToken, string][];
  return Object.fromEntries(
    entries.map(([token, value]) => [token, inkColor(value)]),
  ) as Colors;
}
