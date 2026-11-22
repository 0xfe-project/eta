import type { DocNode } from "@eta/client-contracts/composer-doc";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";

const LEAVES = new Set<string>([
  DOC_NODES.paste,
  DOC_NODES.file,
  DOC_NODES.mention,
  "hardBreak",
  "horizontalRule",
]);

/** A node's size in the document's positions (ProseMirror's: text by its UTF-16 length). */
export function nodeSize(node: DocNode): number {
  if (node.type === DOC_NODES.text) return node.text?.length ?? 0;
  // An inline block (a file, a folded paste, a mention), a break, a rule.
  if (LEAVES.has(node.type)) return 1;
  return 2 + (node.content ?? []).reduce((sum, n) => sum + nodeSize(n), 0);
}

/** The blocks of type `type` in `doc`, nested ones too, with the position each starts at. */
export function blocksOf(
  doc: DocNode,
  type: string,
): { pos: number; node: DocNode }[] {
  const found: { pos: number; node: DocNode }[] = [];
  const walk = (nodes: DocNode[], start: number) => {
    let pos = start;
    for (const node of nodes) {
      if (node.type === type) found.push({ pos, node });
      else if (node.content && !LEAVES.has(node.type))
        walk(node.content, pos + 1);
      pos += nodeSize(node);
    }
  };
  walk(doc.content ?? [], 0);
  return found;
}
