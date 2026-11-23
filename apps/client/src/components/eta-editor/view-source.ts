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

/** What the view always reads: the ends of lines. */
export const lineEnds: MarkdownExtension = {
  name: LINE_END_NODE,
  pattern: LINE_END,
};

const standIns = new WeakSet<MarkdownExtension>();

/** The extension that reads inline blocks of `kind` (a `DOC_NODES` name) back as custom nodes of
 * that name: the view half of a plugin whose editor half makes such blocks. */
export function standIn(kind: string): MarkdownExtension {
  const extension = { name: kind, pattern: `${markOf(kind)}(${TOKENS})` };
  standIns.add(extension);
  return extension;
}

/** The extensions the view needs to read `markdown` itself: a stand-in's only where a block of
 * its kind is (most texts have none, and each extension is looked for in all of the text). */
export function neededExtensions(
  extensions: readonly MarkdownExtension[],
  stands: readonly Stand[],
): MarkdownExtension[] {
  return extensions.filter(
    (extension) =>
      extension !== lineEnds &&
      (!standIns.has(extension) ||
        stands.some((stand) => stand.type === extension.name)),
  );
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** What a text as written would need changed: a line after a line, or a private use character. */
const PLAIN_NOT = /[^\n]\n[^\n]|[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u;
const STARTS_BLOCK = /^ {0,3}(?:[-*+] |1[.)] |#{1,6}(?: |$))/;
const HEADING = /^ {0,3}#{1,6}(?: |$)/;
/** Lines a mark at the end would change: rules and setext underlines, table rows, link
 * definitions, an alert's `[!NOTE]`, and lines that already end in a break. */
const KEEP = [
  /^ {0,3}([-*_])( *\1){2,} *$/,
  /^ {0,3}(=+|-+) *$/,
  /\|/,
  /^ {0,3}\[[^\]]+\]:/,
  /^ {0,3}(?:> ?)+\[![A-Z]+\] *$/i,
  /(\\| {2})$/,
];
const TOKEN = new RegExp(TOKENS, "g");

const standAt = (token: string | undefined, stands: readonly Stand[]) =>
  token ? stands[token.charCodeAt(0) - TOKEN_BASE] : undefined;

/** Marks the end of each line that has a line of text after it, outside code fences. A line is
 * looked at as written: what `markdownSource` kept as its own text (a table's rows, an image) is
 * read through. */
function markLineEnds(source: string, stands: readonly Stand[]): string {
  const lines = source.split("\n");
  const written = (line: string) =>
    line.replace(TOKEN, (token) => {
      const stand = standAt(token, stands);
      return stand?.type === DOC_NODES.text ? (stand.text ?? "") : token;
    });
  let fence: string | undefined;
  for (let at = 0; at < lines.length - 1; at++) {
    const line = written(lines[at]!);
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
    const next = written(lines[at + 1]!);
    if (!line.trim() || !next.trim() || FENCE.test(next)) continue;
    // The next line starts a block of its own (an item, a heading), or this one is a
    // heading: there is no line of a paragraph to keep.
    if (STARTS_BLOCK.test(next) || HEADING.test(line)) continue;
    if (KEEP.some((rule) => rule.test(line))) continue;
    lines[at] += LINE_END;
  }
  return lines.join("\n");
}

/** `text` as the Markdown the view reads, and what its blocks stand for. */
export function viewSource(text: ShownText): {
  markdown: string;
  stands: Stand[];
} {
  // Most texts have nothing to stand in for and one line to a paragraph: they are as written.
  if (
    !text.files?.length &&
    !text.blocks?.length &&
    !(text.mentions?.length && text.text.includes("@")) &&
    !PLAIN_NOT.test(text.text)
  )
    return { markdown: text.text, stands: [] };
  const { source, stands } = markdownSource(text);
  const tokens: string[] = [];
  for (const file of text.files ?? []) {
    if (TOKEN_BASE + stands.length > TOKEN_END) break;
    stands.push({ type: DOC_NODES.file, attrs: { ...file } });
    tokens.push(String.fromCharCode(TOKEN_BASE + stands.length - 1));
  }
  let markdown = "";
  for (const char of markLineEnds(source, stands) +
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

/** Where the parser could read a block's stand-in as code, or a line end matters: the view
 * cannot read such Markdown itself (`viewDocument` puts them right). */
const CODE_LIKE = /`|~~~|\]\(|<|(?:^|\n)(?: {4}|\t)/;

/** Whether the view can read `markdown` itself, its blocks' custom nodes taken back one by one
 * as they are drawn (`standNode`): no line of a paragraph to keep, no block where code is. */
export function readsDirectly(markdown: string, stands: readonly Stand[]) {
  return (
    !markdown.includes(LINE_END) &&
    (!stands.some((stand) => stand.type !== DOC_NODES.text) ||
      !CODE_LIKE.test(markdown))
  );
}

/** A custom node the view read from the Markdown itself, as `viewDocument` would have made it. */
export function standNode(
  node: TextViewCustomNode,
  stands: readonly Stand[],
): TextViewCustomNode {
  const made = custom(node, stands);
  return made.type === "custom" ? made : node;
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

/** A document with each inline node `swap` returns something for put in place of it (nothing: it
 * goes; `undefined`: it stays). A paragraph left with only spaces goes. */
export function swapInline(
  document: TextViewDocument,
  swap: (node: TextViewInline) => TextViewInline[] | undefined,
): TextViewDocument {
  const nodes = (list: readonly TextViewInline[]): TextViewInline[] =>
    list.flatMap((node) => {
      const swapped = swap(node);
      if (swapped) return swapped;
      switch (node.type) {
        case "link":
        case "strong":
        case "emphasis":
        case "strikethrough":
        case "underline":
        case "superscript":
        case "subscript":
        case "small":
        case "highlight":
          return [{ ...node, content: nodes(node.content) } as TextViewInline];
        default:
          return [node];
      }
    });
  const blank = (list: readonly TextViewInline[]) =>
    list.every(
      (node) =>
        node.type === "break" || (node.type === "text" && !node.text.trim()),
    );
  const walk = (list: readonly TextViewBlock[]): TextViewBlock[] =>
    list.flatMap((node): TextViewBlock[] => {
      switch (node.type) {
        case "paragraph": {
          const content = nodes(node.content);
          return content.length !== node.content.length &&
            blank(content) &&
            !blank(node.content)
            ? []
            : [{ ...node, content }];
        }
        case "heading":
          return [{ ...node, content: nodes(node.content) }];
        case "blockquote":
          return [{ ...node, children: walk(node.children) }];
        case "list":
          return [
            {
              ...node,
              items: node.items.map((item) => ({
                ...item,
                children: walk(item.children),
              })),
            },
          ];
        case "table":
          return [
            {
              ...node,
              head: node.head.map((cell) => ({
                ...cell,
                content: nodes(cell.content),
              })),
              rows: node.rows?.map((row) =>
                row.map((cell) => ({ ...cell, content: nodes(cell.content) })),
              ),
            },
          ];
        case "details":
          return [
            {
              ...node,
              summary: nodes(node.summary),
              children: walk(node.children),
            },
          ];
        default:
          return [node];
      }
    });
  return { ...document, blocks: walk(document.blocks) };
}

/** Each inline node of `document`, in order, until `visit` returns true; whether it did. */
export function someInline(
  document: TextViewDocument,
  visit: (node: TextViewInline) => boolean | void,
): boolean {
  const nodes = (list: readonly TextViewInline[]): boolean =>
    list.some((node) => {
      if (visit(node)) return true;
      return "content" in node && Array.isArray(node.content)
        ? nodes(node.content)
        : false;
    });
  const walk = (list: readonly TextViewBlock[]): boolean =>
    list.some((node) => {
      switch (node.type) {
        case "paragraph":
        case "heading":
          return nodes(node.content);
        case "blockquote":
          return walk(node.children);
        case "list":
          return node.items.some((item) => walk(item.children));
        case "table":
          return (
            node.head.some((cell) => nodes(cell.content)) ||
            (node.rows ?? []).some((row) =>
              row.some((cell) => nodes(cell.content)),
            )
          );
        case "details":
          return nodes(node.summary) || walk(node.children);
        default:
          return false;
      }
    });
  return walk(document.blocks);
}
