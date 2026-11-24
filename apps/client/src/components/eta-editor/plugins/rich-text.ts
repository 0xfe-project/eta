import type { TextTheme } from "../look";
import type { TextPlugin } from "../plugin";
import { markdown, StarterKit } from "nsh/base";
import { border, icon, space, weight } from "../../tokens";

/**
 * Formatted text, written as Markdown is: `# ` a heading, `- ` / `1. ` / `[ ] ` a list, `> ` a
 * quote, three backticks a code block, `---` a rule, `**bold**`, `*italic*`, `~~struck~~`,
 * `` `code` `` and links; ⌘B, ⌘I and ⌘E too. No toolbar: the marker is typed and the line turns
 * into the format (Backspace right after brings the marker back). Only what a message can say in
 * Markdown is on — headings H1–H3, bold, italic, strikethrough, inline code, code blocks, quotes,
 * the three kinds of list, links and rules; no tables, underline, highlight, sub- and superscript,
 * alignment or colour. Copies are Markdown on the clipboard; Markdown pasted reads as Markdown
 * (the editor's paste rules decide when: `classifyClipboard`).
 */
export function richText(): TextPlugin {
  return {
    name: "richText",
    editor: {
      rich: true,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          underline: false,
          highlight: false,
          subscript: false,
          superscript: false,
          textAlign: false,
          textStyle: false,
          color: false,
          typography: false,
          image: false,
          history: { depth: 100, newGroupDelay: 500 },
        }),
      ],
      // Pastes go through the editor's rules (`eta-paste`), which read Markdown themselves.
      plugins: [markdown({ paste: false })],
    },
    // The view reads Markdown itself (nsh `TextView`): nothing to add but the look.
    styles: { common: proseStyles, editor: proseEditor, view: proseView },
  };
}

const heading = (
  theme: TextTheme,
  variant: "title" | "subtitle" | "body",
  above: number,
) => ({
  fontSize: theme.face(variant).size,
  lineHeight: theme.face(variant).prose,
  fontWeight: weight.strong,
  marginTop: above,
});

/**
 * The one look of formatted text, in the editor and where it is shown (Paper "Eta · Text",
 * Components › Prose): headings on the type scale (title, subtitle, body; semibold), quotes behind
 * a 2-wide rule in muted ink, code in the monospace face on the selected fill, code blocks square
 * on the surface with a border, links blue and underlined, rules one border wide.
 */
function proseStyles(theme: TextTheme) {
  const c = theme.colors;
  const small = theme.face("small");
  return {
    heading1: heading(theme, "title", 4),
    heading2: heading(theme, "subtitle", 6),
    heading3: heading(theme, "body", 4),
    blockquote: {
      borderLeftWidth: border.thick,
      borderColor: c.strong,
      paddingLeft: space[12],
      color: c.muted,
    },
    list: { paddingLeft: space[20] },
    codeBlock: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 0,
      paddingVertical: space[8],
      paddingHorizontal: space[12],
      marginVertical: space[2],
      fontFamily: theme.mono,
      fontSize: small.size,
      lineHeight: small.prose,
    },
    rule: {
      borderTopWidth: 1,
      borderColor: c.border,
      marginVertical: space[8],
    },
    strong: { fontWeight: weight.strong },
    emphasis: { fontStyle: "italic" as const },
    strikethrough: { textDecorationLine: "line-through" as const },
    code: {
      fontFamily: theme.mono,
      fontSize: small.size,
      backgroundColor: c.selected,
    },
    link: { color: c.blue, textDecorationLine: "underline" as const },
  };
}

/** The editor's own: task lists, list markers and the task box. */
function proseEditor(theme: TextTheme) {
  return {
    nodes: {
      taskList: { paddingLeft: 0 },
      taskItem: { gap: space[8] },
      // Done, as the view shows it: struck through, muted.
      "taskItem[checked=true]": {
        color: theme.colors.muted,
        textDecorationLine: "line-through" as const,
      },
    },
    // The box filled in ink when done (only a class reaches its checked state).
    classes: {
      taskCheckbox: `checked:bg-[${theme.colors.ink}] checked:border-[${theme.colors.ink}]`,
    },
    listMarker: { color: theme.colors.muted },
    taskCheckbox: {
      width: icon.md,
      height: icon.md,
      borderWidth: 1,
      borderColor: theme.colors.strong,
    },
  };
}

/** The view's own: no room under headings and around blocks beyond what the editor leaves, the
 * markers and the task box as the editor draws them. */
function proseView(theme: TextTheme) {
  const none = { marginBottom: 0 };
  return {
    heading1: none,
    heading2: none,
    heading3: none,
    blockquote: { marginVertical: 0, gap: 0 },
    list: { marginVertical: 0, gap: 0, paddingLeft: 0 },
    listItem: { marginVertical: 0, gap: 0 },
    listItemContent: { gap: 0 },
    listMarker: { color: theme.colors.muted },
    taskMarker: {
      width: icon.md,
      height: icon.md,
      borderWidth: 1,
      borderRadius: 0,
      borderColor: theme.colors.strong,
      marginRight: space[8],
    },
    taskMarkerChecked: {
      backgroundColor: theme.colors.ink,
      borderColor: theme.colors.ink,
    },
  };
}
