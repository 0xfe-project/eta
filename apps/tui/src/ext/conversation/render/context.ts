import type { Theme, ThemeToken } from "../../../config/types";
import type { Translate } from "../../../i18n/messages";
import type { Palette } from "../../../ui/gemini/colors";
import type { RenderOptions } from "../contract";
import type { Lines } from "./lines";
import type { RenderMessageKey } from "./messages";
import { THEME_TOKENS } from "../../../config/types";
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
  /** `theme.agents` as Ink colours: what a reply's frame is painted with. */
  agentColors: readonly (string | undefined)[];
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
    agentColors: options.theme.agents.map(inkColor),
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
  return Object.fromEntries(
    THEME_TOKENS.map((token) => [token, inkColor(theme[token])]),
  ) as Colors;
}
