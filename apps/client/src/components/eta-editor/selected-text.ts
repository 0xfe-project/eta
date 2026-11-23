import type { TextViewBlock, TextViewDocument, TextViewInline } from "nsh/base";

/**
 * A part of a shown text as it reads, for finding a selection in it: blocks drawn as views of their
 * own (a mention, a folded paste, a file) are `drawn`, since a platform's selection leaves them out.
 */
interface Piece {
  text: string;
  drawn?: boolean;
}

function inlinePieces(nodes: readonly TextViewInline[], out: Piece[]) {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "keyboard":
        out.push({ text: node.text });
        break;
      case "code":
        out.push({ text: node.code });
        break;
      case "math":
        out.push({ text: node.tex });
        break;
      case "break":
        out.push({ text: "\n" });
        break;
      case "image":
        out.push({ text: node.alt ?? "", drawn: true });
        break;
      case "footnoteReference":
        out.push({ text: node.label, drawn: true });
        break;
      case "custom":
        out.push({ text: node.text ?? "", drawn: true });
        break;
      default:
        inlinePieces(node.content, out);
    }
  }
}

function blockPieces(nodes: readonly TextViewBlock[], out: Piece[]) {
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "heading":
        inlinePieces(node.content, out);
        break;
      case "blockquote":
        blockPieces(node.children, out);
        break;
      case "list":
        for (const item of node.items) blockPieces(item.children, out);
        break;
      case "codeBlock":
        out.push({ text: node.code });
        break;
      case "math":
        out.push({ text: node.tex });
        break;
      case "table":
        for (const row of [node.head, ...(node.rows ?? [])]) {
          for (const cell of row) {
            inlinePieces(cell.content, out);
            out.push({ text: "\t" });
          }
          out.push({ text: "\n" });
        }
        break;
      case "details":
        inlinePieces(node.summary, out);
        out.push({ text: "\n" });
        blockPieces(node.children, out);
        break;
      case "custom":
        out.push({ text: node.text ?? "", drawn: true });
        break;
      default:
        break;
    }
    out.push({ text: "\n" });
  }
}

/** A list's marker as a platform's selection gives it: a tab, then a bullet or a number. */
const MARKER = /\t(?:[•◦▪‣]|\d+[.)])/g;

/**
 * `selected` (a selection's text, as a platform gives it) as it reads in `document`: what a block
 * drawn as a view of its own stands for (a mention is `@Ada`) is back where the selection skipped
 * it, a line goes where the text has one (not where it wrapped on screen), and list markers are
 * gone. `undefined` when the selection is not found in the document.
 */
export function selectedText(
  selected: string,
  document: TextViewDocument,
): string | undefined {
  const pieces: Piece[] = [];
  blockPieces(document.blocks, pieces);
  // The characters that count (no spaces or lines), where each is, and which drawn block it is in.
  const whole: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const block: number[] = [];
  let text = "";
  pieces.forEach((piece, index) => {
    for (const char of piece.text) {
      if (!/\s/.test(char)) {
        whole.push(char);
        from.push(text.length);
        to.push(text.length + char.length);
        block.push(piece.drawn ? index : -1);
      }
      text += char;
    }
  });
  const wanted = [...selected.replace(MARKER, "")].filter(
    (char) => !/\s/.test(char),
  );
  if (!wanted.length) return undefined;
  const blockEnd = (at: number) => {
    let end = at;
    while (end < whole.length && block[end] === block[at]) end++;
    return end;
  };
  // Where `wanted` from `next` ends when matched from `at`: a drawn block matches whole, or is
  // passed over (the selection left it out).
  const match = (at: number, next: number): number | undefined => {
    while (next < wanted.length) {
      if (at >= whole.length) return undefined;
      if (block[at]! >= 0) {
        const end = blockEnd(at);
        let read = next;
        let all = true;
        for (let char = at; char < end; char++, read++)
          if (whole[char] !== wanted[read]) {
            all = false;
            break;
          }
        if (all) {
          const found = match(end, read);
          if (found !== undefined) return found;
        }
        at = end;
        continue;
      }
      if (whole[at] !== wanted[next]) return undefined;
      at++;
      next++;
    }
    return at;
  };
  for (let start = 0; start < whole.length; start++) {
    if (block[start]! >= 0) {
      // A selection starts in a drawn block only when it has all of it.
      if (block[start - 1] === block[start]) continue;
      const end = blockEnd(start);
      if (
        whole.slice(start, end).join("") !==
        wanted.slice(0, end - start).join("")
      )
        continue;
    }
    const end = match(start, 0);
    if (end !== undefined) return text.slice(from[start], to[end - 1]);
  }
  return undefined;
}
