// Copied from `pasteBlocksOf` in apps/web/src/lib/composer.ts. The web and the TUI read a user
// row's folded pastes the same way; keep the two in step until the logic moves to a shared package.
import type { PasteRange } from "../contract";

/**
 * The ranges to fold back in a rendered message: `data.blocks` validated against the text —
 * integer pairs, ascending, disjoint, inside the text. Anything else (an old row, a hand-made
 * one) reads as no blocks, and the message renders the old way.
 */
export function pasteBlocksOf(
  data: Record<string, unknown>,
  text: string,
): PasteRange[] | undefined {
  const raw = data.blocks;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const blocks: PasteRange[] = [];
  let end = 0;
  for (const item of raw) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      !item.every((n) => Number.isInteger(n))
    )
      return undefined;
    const [start, stop] = item as number[];
    if (start < end || start >= stop || stop > text.length) return undefined;
    blocks.push([start, stop]);
    end = stop;
  }
  return blocks;
}
