import type { TextStyle } from "nsh";
import type { RichEditorStyles, TextViewStyles } from "nsh/base";
import type { light, TextFace, TextVariant } from "../theme";
import {
  colors,
  fontFamily,
  Fonts,
  monoFontFamily,
  textFaces,
  textStyle,
} from "../theme";
import * as tokens from "../tokens";

// The look of a text, said once for the editor (nsh `RichEditor`) and for the text shown
// (nsh `TextView`). A plugin says it by part (`TextParts`, TextView's names); each side turns the
// parts into its own: the editor's node and mark styles, the view's part styles. What only one
// side has (the editor's list markers and caret, a node's attribute selector; the view's code
// block parts) the plugin says for that side alone.

/** What a text's styles are made of: the theme's colours, type scale, faces and tokens. */
export interface TextTheme {
  colors: typeof light;
  /** The design's numbers (tokens.ts), for a plugin's spacing and rules. */
  tokens: typeof tokens;
  face: (variant: TextVariant) => TextFace;
  /** The interface font's family stack. */
  font: string;
  /** The monospace family stack. */
  mono: string;
}

/** The theme a text is drawn with, as it changes (in a component). */
export function useTextTheme(): () => TextTheme {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  return () => ({
    colors: c(),
    tokens,
    face: type,
    font: fontFamily(fonts().interface),
    mono: monoFontFamily(fonts()),
  });
}

/** The text's own face, in the editor and in the view: the interface font at the variant's size
 * and its running-text line height, in ink. */
export function baseText(
  theme: TextTheme,
  variant: "body" | "small" = "body",
): TextStyle {
  return {
    color: theme.colors.ink,
    fontFamily: theme.font,
    ...textStyle(theme.face(variant), "prose"),
  };
}

/** The parts both sides have, by TextView's names. */
export interface TextParts {
  heading1?: TextStyle;
  heading2?: TextStyle;
  heading3?: TextStyle;
  blockquote?: TextStyle;
  /** Bulleted and numbered lists. */
  list?: TextStyle;
  /** A code block: its box and its text. */
  codeBlock?: TextStyle;
  /** A rule (`---`). */
  rule?: TextStyle;
  strong?: TextStyle;
  emphasis?: TextStyle;
  strikethrough?: TextStyle;
  /** Code in text. */
  code?: TextStyle;
  link?: TextStyle;
}

/** The editor's own: its parts (list markers, the task box), and node or mark styles by the
 * editor's selectors (`codeBlock[folded=true]`). */
interface EditorLook
  extends Partial<Omit<RichEditorStyles, "nodes" | "marks">> {
  nodes?: Record<string, TextStyle>;
  marks?: Record<string, TextStyle>;
  /** Classes of its parts, for states only classes reach (`checked:` on the task box). */
  classes?: Record<string, string>;
}

/** A plugin's look, from the theme. */
export interface TextStyles {
  /** The parts both sides draw alike. */
  common?: (theme: TextTheme) => TextParts;
  /** Over them, in the editor. */
  editor?: (theme: TextTheme) => EditorLook;
  /** Over them, where the text is shown. */
  view?: (theme: TextTheme) => TextViewStyles;
}

/** Where each part goes in the editor: the node types, or the mark. */
const EDITOR_NODES: Partial<Record<keyof TextParts, string[]>> = {
  heading1: ["heading[level=1]"],
  heading2: ["heading[level=2]"],
  heading3: ["heading[level=3]"],
  blockquote: ["blockquote"],
  list: ["bulletList", "orderedList"],
  codeBlock: ["codeBlock"],
  rule: ["horizontalRule"],
};
const EDITOR_MARKS: Partial<Record<keyof TextParts, string>> = {
  strong: "bold",
  emphasis: "italic",
  strikethrough: "strike",
  code: "code",
  link: "link",
};

/** The text of a style: what a code block's code takes in the view, the box keeping the rest. */
const TEXT_KEYS = new Set([
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
]);

function splitText(style: TextStyle): {
  box: TextStyle;
  text: TextStyle;
} {
  const box: Record<string, unknown> = {};
  const text: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style))
    (TEXT_KEYS.has(key) ? text : box)[key] = value;
  return { box: box as TextStyle, text: text as TextStyle };
}

const over = <T extends object>(base: T | undefined, top: T | undefined): T =>
  ({ ...base, ...top }) as T;

/** The plugins' common parts, over one another in their order. */
export function partsOf(
  plugins: readonly { styles?: TextStyles }[],
  theme: TextTheme,
): TextParts {
  const parts: Record<string, TextStyle> = {};
  for (const plugin of plugins)
    for (const [key, value] of Object.entries(
      plugin.styles?.common?.(theme) ?? {},
    ))
      parts[key] = over(parts[key], value as TextStyle);
  return parts as TextParts;
}

/** The plugins' look in the editor: node and mark styles, and the editor's own parts. */
export function editorLook(
  plugins: readonly { styles?: TextStyles }[],
  theme: TextTheme,
): {
  nodes: Record<string, TextStyle>;
  marks: Record<string, TextStyle>;
  own: Partial<RichEditorStyles>;
  classes: Record<string, string>;
} {
  const nodes: Record<string, TextStyle> = {};
  const marks: Record<string, TextStyle> = {};
  for (const [part, style] of Object.entries(partsOf(plugins, theme))) {
    const key = part as keyof TextParts;
    for (const node of EDITOR_NODES[key] ?? [])
      nodes[node] = over(nodes[node], style);
    const mark = EDITOR_MARKS[key];
    if (mark) marks[mark] = over(marks[mark], style);
  }
  let own: Partial<RichEditorStyles> = {};
  const classes: Record<string, string> = {};
  for (const plugin of plugins) {
    const {
      nodes: n,
      marks: m,
      classes: c,
      ...rest
    } = plugin.styles?.editor?.(theme) ?? {};
    for (const [key, value] of Object.entries(c ?? {}))
      classes[key] = classes[key] ? `${classes[key]} ${value}` : value;
    for (const [key, value] of Object.entries(n ?? {}))
      nodes[key] = over(nodes[key], value);
    for (const [key, value] of Object.entries(m ?? {}))
      marks[key] = over(marks[key], value);
    own = { ...own, ...rest };
  }
  return { nodes, marks, own, classes };
}

/** The plugins' look where the text is shown: TextView's part styles. */
export function viewLook(
  plugins: readonly { styles?: TextStyles }[],
  theme: TextTheme,
): TextViewStyles {
  const { codeBlock, ...parts } = partsOf(plugins, theme);
  const styles: Record<string, unknown> = { ...parts };
  // A table is part of the text, not the renderer's own drawing: its cells say the ink, its header
  // reads as a muted strong label over a faint band, and the hairlines nsh draws take the palette's
  // border. Only the colours: nsh sets the line widths, so no line appears or goes.
  styles.tableGrid = {
    borderTopColor: theme.colors.border,
    borderLeftColor: theme.colors.border,
  };
  styles.tableHead = { backgroundColor: theme.colors.overlay };
  styles.tableCell = {
    color: theme.colors.ink,
    borderRightColor: theme.colors.border,
    borderBottomColor: theme.colors.border,
  };
  styles.tableHeaderCell = {
    color: theme.colors.mutedInk,
    fontWeight: theme.tokens.weight.strong,
    borderRightColor: theme.colors.border,
    borderBottomColor: theme.colors.border,
  };
  if (codeBlock) {
    const { box, text } = splitText(codeBlock);
    styles.codeBlock = box;
    styles.codeBlockCode = text;
  }
  for (const plugin of plugins)
    for (const [key, value] of Object.entries(
      plugin.styles?.view?.(theme) ?? {},
    ))
      styles[key] = over(styles[key] as object, value as object);
  return styles as TextViewStyles;
}
