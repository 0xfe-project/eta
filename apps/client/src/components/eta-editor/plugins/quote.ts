import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { EtaEditorHandle, EtaPlugin } from "../editor";
import { DOC_NODES, textToNodes } from "@eta/client-contracts/composer-doc";
import { chain, focus, insertContentAt, scrollIntoView } from "nsh/base";
import { oneStep } from "../step";

/** `selected` as Markdown quote lines (`> ...`, a blank line as `>`); `""` when it is blank. */
export function quoteMarkdown(selected: string): string {
  const text = selected.trim();
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .map((line) => (line.trimEnd() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
}

/** A node's size in the document's positions (ProseMirror's: text by its UTF-16 length). */
function nodeSize(node: DocNode): number {
  if (node.type === DOC_NODES.text) return node.text?.length ?? 0;
  if (node.type === DOC_NODES.paragraph)
    return 2 + (node.content ?? []).reduce((sum, n) => sum + nodeSize(n), 0);
  // An inline block: a file, a folded paste, a mention.
  return 1;
}

const empty: DocNode = { type: DOC_NODES.paragraph };

/**
 * Quotes text from elsewhere (a part of a reply the reader selected) after the draft: a blank
 * line, the quote, a blank line, and the caret on the line below to answer it. What is in the
 * draft (words, files, folded pastes, mentions) stays as it is; only blank lines at its end make
 * way for the quote's own. One undo step takes the quote back out.
 */
export function quote(): EtaPlugin & {
  append: (selected: string) => boolean;
} {
  let editor: EtaEditorHandle | undefined;
  return {
    name: "quote",
    setup(handle) {
      editor = handle;
    },
    append(selected) {
      const markdown = quoteMarkdown(selected);
      if (!editor || !markdown) return false;
      const blocks = editor.doc().content ?? [];
      const size = blocks.reduce((sum, block) => sum + nodeSize(block), 0);
      // Blank lines at the end of the draft make way: the quote brings its own.
      let kept = blocks.length;
      let from = size;
      while (kept > 0) {
        const block = blocks[kept - 1]!;
        if (block.type !== DOC_NODES.paragraph || block.content?.length) break;
        from -= nodeSize(block);
        kept--;
      }
      const blank = kept === 0;
      const nodes = [
        ...(blank ? [] : [empty]),
        ...textToNodes(markdown),
        empty,
        empty,
      ];
      const done = editor.session.run(
        oneStep(
          chain([
            insertContentAt({ from, to: size }, nodes),
            focus("end"),
            scrollIntoView(),
          ]),
        ),
      );
      editor.focus();
      return done;
    },
  };
}
