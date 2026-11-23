import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { EtaEditorHandle } from "../editor";
import type { TextPlugin } from "../plugin";
import { DOC_NODES, textToNodes } from "@eta/client-contracts/composer-doc";
import { chain, focus, insertContentAt, scrollIntoView } from "nsh/base";
import { nodeSize } from "../positions";
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

const empty: DocNode = { type: DOC_NODES.paragraph };

/**
 * Quotes text from elsewhere (a part of a reply the reader selected) after the draft: a blank
 * line, the quote, a blank line, and the caret on the line below to answer it. In formatted text
 * the quote is a quote block, which goes as the same `> …` lines. What is in the
 * draft (words, files, folded pastes, mentions) stays as it is; only blank lines at its end make
 * way for the quote's own. One undo step takes the quote back out.
 */
export function quote(): TextPlugin & {
  append: (selected: string) => boolean;
} {
  let editor: EtaEditorHandle | undefined;
  return {
    name: "quote",
    editor: {
      setup(handle) {
        editor = handle;
      },
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
      // Formatted text quotes as a quote (written `> …` when it goes); plain text as its lines.
      const nodes = editor.rich
        ? [{ type: "blockquote", content: textToNodes(selected.trim()) }, empty]
        : [...(blank ? [] : [empty]), ...textToNodes(markdown), empty, empty];
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
