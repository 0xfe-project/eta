import type { TextPlugin } from "../plugin";
import { Document, History, Paragraph, richExtension } from "nsh/base";

/**
 * Plain text: paragraphs of text and nothing else — no marks, no headings, no lists. A paste of
 * rich text (a web page, Word) goes in as its plain text (`eta-paste` in the editor routes it to
 * `pasteText`), as the web composer's PlainTextPlugin does. Undo and redo come with it: a paste,
 * a block put in or unfolded is one step each.
 */
export function plainText(): TextPlugin {
  return {
    name: "plainText",
    editor: {
      extensions: [
        Document,
        Paragraph,
        richExtension("text"),
        History.configure({ depth: 100, newGroupDelay: 500 }),
      ],
    },
  };
}
