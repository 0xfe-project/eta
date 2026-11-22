import type { EtaPlugin, TextTheme } from "../editor";
import { markdown, StarterKit } from "nsh/base";

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
export function richText(): EtaPlugin {
  return {
    name: "richText",
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
    styles: { common: proseStyles, editor: proseParts },
  };
}

const heading = (
  theme: TextTheme,
  variant: "title" | "subtitle" | "body",
  above: number,
) => ({
  fontSize: theme.face(variant).size,
  lineHeight: theme.face(variant).prose,
  fontWeight: 600,
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
    nodes: {
      "heading[level=1]": heading(theme, "title", 4),
      "heading[level=2]": heading(theme, "subtitle", 6),
      "heading[level=3]": heading(theme, "body", 4),
      blockquote: {
        borderLeftWidth: 2,
        borderColor: c.strong,
        paddingLeft: 10,
        color: c.muted,
      },
      bulletList: { paddingLeft: 20 },
      orderedList: { paddingLeft: 20 },
      taskList: { paddingLeft: 0 },
      taskItem: { gap: 8 },
      codeBlock: {
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 0,
        paddingVertical: 8,
        paddingHorizontal: 12,
        marginVertical: 2,
        fontFamily: theme.mono,
        fontSize: small.size,
        lineHeight: small.prose,
      },
      horizontalRule: {
        borderTopWidth: 1,
        borderColor: c.border,
        marginVertical: 6,
      },
    },
    marks: {
      bold: { fontWeight: 600 },
      italic: { fontStyle: "italic" as const },
      strike: { textDecorationLine: "line-through" as const },
      code: {
        fontFamily: theme.mono,
        fontSize: small.size,
        backgroundColor: c.selected,
      },
      link: { color: c.blue, textDecorationLine: "underline" as const },
    },
  };
}

function proseParts(theme: TextTheme) {
  return {
    listMarker: { color: theme.colors.muted },
    taskCheckbox: {
      width: 14,
      height: 14,
      borderWidth: 1,
      borderColor: theme.colors.strong,
    },
  };
}
