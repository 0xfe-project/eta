import type { Stand } from "@eta/client-contracts/composer-markdown";
import type {
  MarkdownExtension,
  TextViewBlock,
  TextViewCustomNode,
  TextViewDocument,
  TextViewInline,
} from "nsh/base";
import type { StoredText } from "./markdown";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import {
  markdownSource,
  standText,
  TOKEN_BASE,
  TOKEN_END,
} from "@eta/client-contracts/composer-markdown";

// Text as kept, ready for nsh's TextView. The kept Markdown is read as the editor reads it
// (`markdownToDoc`), so what is shown is what was written:
// - each inline block (a mention, a folded paste, a file) stands in the Markdown as a mark of its
//   kind and one character for which one it is; the plugin that draws it reads that back with a
//   `pattern` extension (`standIn`), and gets the block's attributes in its custom node;
// - each line of a paragraph is a line (the editor makes it a paragraph of its own; CommonMark
//   would join the lines with a space): the end of such a line carries a mark the view turns into
//   a line break.
// Where the parser reads text as code (a code block, inline code, a link's address), whatever
// stands in is put back as its text.

/** A file sent with the text: shown after it, as the editor shows it among its words. */
interface ShownFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

/** Text to show: as kept, and the files that went with it. */
export interface ShownText extends StoredText {
  files?: readonly ShownFile[];
}

/** The marks of the kinds of block, in the private use plane (one each, as the kinds are named). */
const KIND_BASE = 0xf0000;
const kinds = new Map<string, string>();
function markOf(kind: string): string {
  let mark = kinds.get(kind);
  if (!mark) {
    mark = String.fromCodePoint(KIND_BASE + 1 + kinds.size);
    kinds.set(kind, mark);
  }
  return mark;
}

/** The end of a line of a paragraph. */
const LINE_END = String.fromCodePoint(KIND_BASE);
const LINE_END_NODE = "etaLineEnd";
const TOKENS = `[${String.fromCharCode(TOKEN_BASE)}-${String.fromCharCode(TOKEN_END)}]`;

/** The extension that reads inline blocks of `kind` (a `DOC_NODES` name) back as custom nodes of
 * that name: the view half of a plugin whose editor half makes such blocks. */
export function standIn(kind: string): MarkdownExtension {
  return { name: kind, pattern: `${markOf(kind)}(${TOKENS})` };
}

/** What the view always reads: the ends of lines. */
export const lineEnds: MarkdownExtension = {
  name: LINE_END_NODE,
  pattern: LINE_END,
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Lines a mark at the end would change: rules and setext underlines, table rows, link
 * definitions, and lines that already end in a break. */
const KEEP = [
  /^ {0,3}([-*_])( *\1){2,} *$/,
  /^ {0,3}(=+|-+) *$/,
  /\|/,
  /^ {0,3}\[[^\]]+\]:/,
  /(\\| {2})$/,
];

/** Marks the end of each line that has a line of text after it, outside code fences. */
function markLineEnds(source: string): string {
  const lines = source.split("\n");
  let fence: string | undefined;
  for (let at = 0; at < lines.length - 1; at++) {
    const line = lines[at]!;
    const opened = FENCE.exec(line)?.[1];
    if (fence) {
      if (
        opened?.[0] === fence[0] &&
        opened.length >= fence.length &&
        !line.trim().slice(opened.length).trim()
      )
        fence = undefined;
      continue;
    }
    if (opened) {
      fence = opened;
      continue;
    }
    const next = lines[at + 1]!;
    if (!line.trim() || !next.trim() || FENCE.test(next)) continue;
    if (KEEP.some((rule) => rule.test(line))) continue;
    lines[at] = line + LINE_END;
  }
  return lines.join("\n");
}

/** `text` as the Markdown the view reads, and what its blocks stand for. */
export function viewSource(text: ShownText): {
  markdown: string;
  stands: Stand[];
} {
  const { source, stands } = markdownSource(text);
  const tokens: string[] = [];
  for (const file of text.files ?? []) {
    if (TOKEN_BASE + stands.length > TOKEN_END) break;
    stands.push({ type: DOC_NODES.file, attrs: { ...file } });
    tokens.push(String.fromCharCode(TOKEN_BASE + stands.length - 1));
  }
  let markdown = "";
  for (const char of markLineEnds(source) +
    (tokens.length ? `\n\n${tokens.join(" ")}` : "")) {
    const code = char.charCodeAt(0);
    const stand =
      char.length === 1 && code >= TOKEN_BASE && code <= TOKEN_END
        ? stands[code - TOKEN_BASE]
        : undefined;
    if (!stand) markdown += char;
    else if (stand.type === DOC_NODES.text) markdown += stand.text ?? "";
    else markdown += markOf(stand.type) + char;
  }
  return { markdown, stands };
}

const standAt = (token: string | undefined, stands: readonly Stand[]) =>
  token ? stands[token.charCodeAt(0) - TOKEN_BASE] : undefined;

/** Text where only text goes: blocks as their text, line ends gone. */
function plain(text: string, stands: readonly Stand[]): string {
  let out = "";
  const chars = [...text];
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    if (char === LINE_END) continue;
    if ((char.codePointAt(0) ?? 0) > KIND_BASE) {
      const stand = standAt(chars[at + 1], stands);
      if (stand) {
        out +=
          stand.type === DOC_NODES.file
            ? String(stand.attrs?.name ?? "")
            : standText(stand);
        at++;
        continue;
      }
    }
    out += char;
  }
  return out;
}

const isBreak = (node: TextViewInline | undefined) => node?.type === "break";

function inline(
  nodes: readonly TextViewInline[],
  stands: readonly Stand[],
): TextViewInline[] {
  const out: TextViewInline[] = [];
  let afterBreak = false;
  for (const node of nodes) {
    let next: TextViewInline | undefined;
    switch (node.type) {
      case "custom":
        if (node.name === LINE_END_NODE) {
          out.push({ type: "break" });
          afterBreak = true;
          continue;
        }
        next = custom(node, stands);
        break;
      case "text": {
        let text = plain(node.text, stands);
        // The line's own end, which CommonMark reads as a space.
        if (afterBreak) text = text.replace(/^[ \t\n]+/, "");
        next = text ? { type: "text", text } : undefined;
        break;
      }
      case "code":
        next = { type: "code", code: plain(node.code, stands) };
        break;
      case "link":
        next = {
          ...node,
          url: plain(node.url, stands),
          content: inline(node.content, stands),
        };
        break;
      case "strong":
      case "emphasis":
      case "strikethrough":
      case "underline":
      case "superscript":
      case "subscript":
      case "small":
      case "highlight":
        next = { ...node, content: inline(node.content, stands) };
        break;
      default:
        next = node;
    }
    afterBreak = false;
    if (next) out.push(next);
  }
  // A line end at the end of a block (the next line was a block of its own) breaks nothing.
  while (isBreak(out.at(-1))) out.pop();
  while (isBreak(out[0])) out.shift();
  return out;
}

/** A block's custom node: an inline block with the attributes of what it stands for. */
function custom(
  node: TextViewCustomNode,
  stands: readonly Stand[],
): TextViewInline {
  const stand = standAt(node.attributes?.["1"], stands);
  if (!stand || stand.type !== node.name)
    return {
      type: "custom",
      ...node,
      ...(node.content ? { content: inline(node.content, stands) } : {}),
      ...(node.children ? { children: blocks(node.children, stands) } : {}),
    };
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(stand.attrs ?? {}))
    attributes[key] = String(value);
  return {
    type: "custom",
    name: node.name,
    attributes,
    text: standText(stand),
  };
}

function blocks(
  nodes: readonly TextViewBlock[],
  stands: readonly Stand[],
): TextViewBlock[] {
  return nodes.map((node): TextViewBlock => {
    switch (node.type) {
      case "paragraph":
      case "heading":
        return { ...node, content: inline(node.content, stands) };
      case "blockquote":
        return { ...node, children: blocks(node.children, stands) };
      case "list":
        return {
          ...node,
          items: node.items.map((item) => ({
            ...item,
            children: blocks(item.children, stands),
          })),
        };
      case "codeBlock":
        return {
          ...node,
          code: plain(node.code, stands),
          ...(node.language ? { language: plain(node.language, stands) } : {}),
          ...(node.meta ? { meta: plain(node.meta, stands) } : {}),
        };
      case "table":
        return {
          ...node,
          head: node.head.map((cell) => ({
            ...cell,
            content: inline(cell.content, stands),
          })),
          rows: node.rows?.map((row) =>
            row.map((cell) => ({
              ...cell,
              content: inline(cell.content, stands),
            })),
          ),
        };
      case "details":
        return {
          ...node,
          summary: inline(node.summary, stands),
          children: blocks(node.children, stands),
        };
      case "custom":
        return custom(node, stands) as TextViewBlock;
      default:
        return node;
    }
  });
}

/** The parsed view Markdown as the view shows it: blocks with their attributes, line ends as
 * breaks, code as its text. */
export function viewDocument(
  parsed: TextViewDocument,
  stands: readonly Stand[],
): TextViewDocument {
  return {
    ...parsed,
    blocks: blocks(parsed.blocks, stands),
    ...(parsed.footnotes
      ? {
          footnotes: parsed.footnotes.map((note) => ({
            ...note,
            children: blocks(note.children, stands),
          })),
        }
      : {}),
  };
}
