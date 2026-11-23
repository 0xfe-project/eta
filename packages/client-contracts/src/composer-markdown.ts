// Markdown is how a message (or a description) is kept: the editor's document is written as
// Markdown when it goes out, and read back from Markdown to edit or show it again. Everything here
// is plain data; the client's text system reads Markdown with nsh's parser and hands the result
// to `restoreDoc`, and checks a written message by reading it back (`sameDoc`).
//
// The editor's own inline blocks keep the wire format a message has always had:
// - a mention is the text `@label`, its member's id in `mentions`;
// - a folded paste is its text, verbatim, its place in the text a `PasteRange` in `blocks`;
// - a file is nothing in the text: it goes as an attachment.
// Plain words are written as they were typed (`snake_case`, `a*b`), as before; only where the
// text would read back as something else is it escaped (the client decides, per block).

import type { DocNode, SerializedDraft } from "./composer-doc";
import type { PasteRange } from "./composer-draft";
import { DOC_NODES, normalizeNewlines } from "./composer-doc";

/** The rich document's node and mark names (nsh's StarterKit, Tiptap's names). */
export const RICH_NODES = {
  heading: "heading",
  blockquote: "blockquote",
  bulletList: "bulletList",
  orderedList: "orderedList",
  taskList: "taskList",
  listItem: "listItem",
  taskItem: "taskItem",
  codeBlock: "codeBlock",
  horizontalRule: "horizontalRule",
  hardBreak: "hardBreak",
} as const;

export const RICH_MARKS = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
  link: "link",
} as const;

/** The deepest heading the editor has: `####` and deeper read as this level. */
export const MAX_HEADING = 3;

/** How a block's words are written: as typed, or with Markdown's characters escaped. */
export type Escaping = "raw" | "escaped";

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}
type MarkedNode = DocNode & { marks?: Mark[] };

const MARK_ORDER = [
  RICH_MARKS.link,
  RICH_MARKS.bold,
  RICH_MARKS.italic,
  RICH_MARKS.strike,
  RICH_MARKS.code,
] as const;

const rank = (mark: Mark) => {
  const at = (MARK_ORDER as readonly string[]).indexOf(mark.type);
  return at < 0 ? MARK_ORDER.length : at;
};

function marksOf(node: DocNode): Mark[] {
  return [...((node as MarkedNode).marks ?? [])]
    .filter((mark) => (MARK_ORDER as readonly string[]).includes(mark.type))
    .sort((a, b) => rank(a) - rank(b));
}

const sameMark = (a: Mark, b: Mark) =>
  a.type === b.type &&
  (a.type !== RICH_MARKS.link || a.attrs?.href === b.attrs?.href);

const isList = (type: string) =>
  type === RICH_NODES.bulletList ||
  type === RICH_NODES.orderedList ||
  type === RICH_NODES.taskList;

const sameMarks = (a: Mark[], b: Mark[]) =>
  a.length === b.length && a.every((mark, i) => sameMark(mark, b[i]!));

/** A paste's text stands in the Markdown as one of these until the end: one character each. */
export const TOKEN_BASE = 0xe000;
export const TOKEN_END = 0xf8ff;
const isToken = (code: number) => code >= TOKEN_BASE && code <= TOKEN_END;

function escapeInline(text: string): string {
  return text.replace(/[\\`*_~[\]<>|]/g, "\\$&");
}

/** Escapes what would start a block at the start of a line (`# `, `- `, `1. `, `>`, `===`). */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+=-])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/, "$1\\$2");
}

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const pad = /^`|`$|^ .* $/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function linkEnd(mark: Mark): string {
  const href = String(mark.attrs?.href ?? "");
  const target = /[\s()<>]/.test(href)
    ? `<${href.replace(/>/g, "%3E")}>`
    : href;
  return `](${target})`;
}

class Writer {
  /** What each token stands for: a paste's text (its place a range), or a character as is. */
  pastes: { text: string; range: boolean }[] = [];
  mentions: string[] = [];
  files: string[] = [];
  readonly escaping: Escaping;
  constructor(escaping: Escaping) {
    this.escaping = escaping;
  }

  /** A paragraph's (or heading's) inline content: marks as delimiters, blocks as their text. */
  inline(nodes: DocNode[], heading = false): string {
    let out = "";
    let open: Mark[] = [];
    let pending = "";
    const closer = (mark: Mark) =>
      mark.type === RICH_MARKS.link
        ? linkEnd(mark)
        : mark.type === RICH_MARKS.bold
          ? "**"
          : mark.type === RICH_MARKS.italic
            ? "*"
            : mark.type === RICH_MARKS.strike
              ? "~~"
              : "";
    const opener = (mark: Mark) =>
      mark.type === RICH_MARKS.link ? "[" : closer(mark);
    const close = (keep: number) => {
      for (let i = open.length - 1; i >= keep; i--) out += closer(open[i]!);
      open = open.slice(0, keep);
    };
    for (const node of merge(nodes)) {
      const marks = marksOf(node);
      let text: string;
      let lead = "";
      let trail = "";
      if (node.type === DOC_NODES.text) {
        const raw = node.text ?? "";
        const code = marks.some((mark) => mark.type === RICH_MARKS.code);
        // Emphasis cannot start or end on a space: spaces go outside the marks.
        const core = raw.trim();
        if (!core) {
          pending += raw;
          continue;
        }
        lead = raw.slice(0, raw.indexOf(core));
        trail = raw.slice(raw.indexOf(core) + core.length);
        text = this.literal(
          code
            ? codeSpan(core)
            : this.escaping === "escaped"
              ? escapeInline(core)
              : core,
        );
      } else text = this.atom(node, heading);
      let keep = 0;
      while (
        keep < open.length &&
        keep < marks.length &&
        sameMark(open[keep]!, marks[keep]!)
      )
        keep++;
      close(keep);
      out += pending + lead;
      pending = trail;
      for (const mark of marks.slice(keep)) {
        if (mark.type !== RICH_MARKS.code) out += opener(mark);
        open.push(mark);
      }
      out += text;
    }
    close(0);
    out += pending;
    return heading ? out.replace(/\n/g, " ") : out;
  }

  token(text: string, range: boolean): string {
    this.pastes.push({ text, range });
    return String.fromCharCode(TOKEN_BASE + this.pastes.length - 1);
  }

  /** Characters of the private use area the words hold, as tokens, so they stay as they are. */
  literal(text: string): string {
    return text.replace(/[\uE000-\uF8FF]/g, (char) => this.token(char, false));
  }

  atom(node: DocNode, heading: boolean): string {
    switch (node.type) {
      case DOC_NODES.mention: {
        const id = String(node.attrs?.id ?? "");
        if (id && !this.mentions.includes(id)) this.mentions.push(id);
        return `@${String(node.attrs?.label ?? id)}`;
      }
      case DOC_NODES.paste: {
        return this.token(String(node.attrs?.text ?? ""), true);
      }
      case DOC_NODES.file:
        this.files.push(String(node.attrs?.id ?? ""));
        return "";
      case RICH_NODES.hardBreak:
        return heading ? " " : "\n";
      default:
        return textOf(node);
    }
  }

  /** A block as its lines. */
  block(node: DocNode): string[] {
    const content = node.content ?? [];
    switch (node.type) {
      case DOC_NODES.paragraph: {
        const lines = this.inline(content).split("\n");
        return this.escaping === "escaped" ? lines.map(escapeLineStart) : lines;
      }
      case RICH_NODES.heading: {
        const level = Math.min(
          MAX_HEADING,
          Math.max(1, Number(node.attrs?.level ?? 1)),
        );
        return [`${"#".repeat(level)} ${this.inline(content, true)}`.trimEnd()];
      }
      case RICH_NODES.codeBlock: {
        const code = textOf(node);
        const runs = code.match(/^`{3,}/gm) ?? [];
        const fence = "`".repeat(
          Math.max(3, ...runs.map((run) => run.length + 1)),
        );
        const language = String(node.attrs?.language ?? "").trim();
        return [
          `${fence}${language}`,
          ...this.literal(code).split("\n"),
          fence,
        ];
      }
      case RICH_NODES.horizontalRule:
        return ["---"];
      case RICH_NODES.blockquote:
        return this.blocks(content).map((line) => (line ? `> ${line}` : ">"));
      case RICH_NODES.bulletList:
      case RICH_NODES.orderedList:
      case RICH_NODES.taskList: {
        const start = Number(node.attrs?.start ?? 1);
        return content.flatMap((item, index) => {
          const marker =
            node.type === RICH_NODES.orderedList
              ? `${start + index}. `
              : node.type === RICH_NODES.taskList
                ? "- "
                : "- ";
          const box =
            node.type === RICH_NODES.taskList
              ? item.attrs?.checked
                ? "[x] "
                : "[ ] "
              : "";
          const lines = this.blocks(item.content ?? [], true);
          const indent = " ".repeat(marker.length);
          return lines.map((line, at) =>
            at === 0
              ? `${marker}${box}${line}`.trimEnd()
              : line
                ? `${indent}${line}`
                : "",
          );
        });
      }
      default:
        // A block the editor does not make (none should come): its text, as a paragraph.
        return content.length
          ? this.block({ type: DOC_NODES.paragraph, content })
          : [textOf(node)];
    }
  }

  /** Sibling blocks: two paragraphs are two lines; anything else has a blank line between. */
  blocks(nodes: DocNode[], item = false): string[] {
    const lines: string[] = [];
    const table = tableRows(nodes);
    nodes.forEach((node, index) => {
      const previous = nodes[index - 1];
      if (previous) {
        // A table's rows (kept as lines of text) have a blank line around them, as written.
        const paragraphs =
          previous.type === DOC_NODES.paragraph &&
          node.type === DOC_NODES.paragraph &&
          table[index - 1] === table[index];
        // A list in an item follows its line, except an ordered one not starting at 1: Markdown
        // reads that as the line going on (it may not interrupt a paragraph), so it gets a blank
        // line before it.
        const nested =
          item &&
          isList(node.type) &&
          !(
            node.type === RICH_NODES.orderedList &&
            Number(node.attrs?.start ?? 1) !== 1
          );
        if (!paragraphs && !nested) lines.push("");
      }
      lines.push(...this.block(node));
    });
    return lines;
  }
}

/**
 * Which of sibling blocks are the rows of a table kept as lines of text (`literals`): for each, the
 * number of its table, counting from 1; 0 for any other block.
 */
function tableRows(nodes: DocNode[]): number[] {
  const out = nodes.map(() => 0);
  const line = (node: DocNode | undefined) =>
    node?.type === DOC_NODES.paragraph ? textOf(node) : undefined;
  let count = 0;
  for (let at = 0; at < nodes.length; at++) {
    const header = line(nodes[at]);
    const next = line(nodes[at + 1]);
    if (!header?.includes("|") || next === undefined || !isTableDelimiter(next))
      continue;
    count++;
    let stop = at;
    while (stop < nodes.length && line(nodes[stop])?.includes("|"))
      out[stop++] = count;
    at = stop - 1;
  }
  return out;
}

/** Neighbouring text with the same marks as one text node. */
function merge(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (
      last &&
      node.type === DOC_NODES.text &&
      last.type === DOC_NODES.text &&
      sameMarks(marksOf(last), marksOf(node))
    )
      out[out.length - 1] = { ...last, text: (last.text ?? "") + node.text };
    else out.push(node);
  }
  return out;
}

function textOf(node: DocNode): string {
  if (node.type === DOC_NODES.text) return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

/**
 * The document as a message: its Markdown, each folded paste's place (`blocks`), the mentioned
 * member ids and the attachment block ids, in document order. Blank lines before and after are
 * left out. `escaping` says, per top-level block, whether its words are escaped (raw by default).
 */
export function docToMarkdown(
  doc: DocNode,
  escaping: (index: number) => Escaping = () => "raw",
): SerializedDraft {
  const blocks = doc.content ?? [];
  const writers = blocks.map((_, index) => new Writer(escaping(index)));
  const lines: string[] = [];
  const pastes: { text: string; range: boolean }[] = [];
  const mentions: string[] = [];
  const files: string[] = [];
  const table = tableRows(blocks);
  blocks.forEach((node, index) => {
    const previous = blocks[index - 1];
    if (
      previous &&
      !(
        previous.type === DOC_NODES.paragraph &&
        node.type === DOC_NODES.paragraph &&
        table[index - 1] === table[index]
      )
    )
      lines.push("");
    const writer = writers[index]!;
    // Every writer numbers its pastes from 0: renumber them into the document's.
    const own = writer
      .block(node)
      .map((line) =>
        line.replace(/[\uE000-\uF8FF]/g, (token) =>
          String.fromCharCode(
            TOKEN_BASE + pastes.length + token.charCodeAt(0) - TOKEN_BASE,
          ),
        ),
      );
    pastes.push(...writer.pastes);
    for (const id of writer.mentions)
      if (!mentions.includes(id)) mentions.push(id);
    files.push(...writer.files);
    lines.push(...own);
  });
  const joined = lines.join("\n");
  // Blank lines and spaces around the message are not part of it.
  const start = joined.search(/\S/);
  const body = start < 0 ? "" : joined.slice(start).trimEnd();
  let text = "";
  const ranges: PasteRange[] = [];
  for (const char of body) {
    const code = char.charCodeAt(0);
    const paste =
      char.length === 1 && isToken(code)
        ? pastes[code - TOKEN_BASE]
        : undefined;
    if (!paste) {
      text += char;
      continue;
    }
    if (paste.range)
      ranges.push([text.length, text.length + paste.text.length]);
    text += paste.text;
  }
  return { text, blocks: ranges, mentions, files };
}

/** A member a message mentions, as its text names them (`@label`). */
export interface MentionRef {
  id: string;
  label: string;
}

/** What `markdownSource` stood in for: put back by `restoreDoc`. */
export type Stand = DocNode;

const PREFIX = /[\s,.!?;:，。！？、；：（(]/;

/**
 * Markdown ready for the parser: each folded paste (`blocks`) and each mention of `mentions`
 * replaced by one character that stands for it, so the parser reads neither (a paste is never
 * Markdown, a name is not emphasis). Characters of the private use area already in the text are
 * stood in for as well, so they come back as they were.
 */
export function markdownSource(input: {
  text: string;
  blocks?: readonly PasteRange[];
  mentions?: readonly MentionRef[];
}): { source: string; stands: Stand[] } {
  const stands: Stand[] = [];
  const stand = (node: Stand) => {
    if (stands.length > TOKEN_END - TOKEN_BASE) return undefined;
    stands.push(node);
    return String.fromCharCode(TOKEN_BASE + stands.length - 1);
  };
  const text = input.text;
  const labels = [...(input.mentions ?? [])]
    .filter((mention) => mention.label)
    .sort((a, b) => b.label.length - a.label.length);
  /** Text between pastes: mentions and private-use characters stood in for. */
  const words = (part: string) => {
    let out = "";
    for (let at = 0; at < part.length; ) {
      const code = part.charCodeAt(at);
      if (isToken(code)) {
        out += stand({ type: DOC_NODES.text, text: part[at]! }) ?? part[at]!;
        at++;
        continue;
      }
      if (part[at] === "@" && (at === 0 || PREFIX.test(part[at - 1]!))) {
        const found = labels.find((mention) =>
          part.startsWith(mention.label, at + 1),
        );
        if (found) {
          const token = stand({
            type: DOC_NODES.mention,
            attrs: { id: found.id, label: found.label },
          });
          if (token) {
            out += token;
            at += found.label.length + 1;
            continue;
          }
        }
      }
      out += part[at];
      at++;
    }
    return out;
  };
  let source = "";
  let end = 0;
  for (const [start, stop] of input.blocks ?? []) {
    if (start < end || stop > text.length || start >= stop) continue;
    const before = words(text.slice(end, start));
    const token = stand({
      type: DOC_NODES.paste,
      attrs: { id: `paste-${start}`, text: text.slice(start, stop) },
    });
    source += before;
    end = start;
    if (!token) continue;
    source += token;
    end = stop;
  }
  source += words(text.slice(end));
  return { source: literals(source, stand), stands };
}

/** A GFM table's delimiter row: `| --- | :-: |`. */
function isTableDelimiter(line: string): boolean {
  if (!line.includes("|") || /^ {4}/.test(line)) return false;
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}
/** Markdown's image: `![alt](src)`. */
const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
/** A code fence's opening or closing line. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * What the editor has no block for, kept as the text it was written as: each row of a table (the
 * reader would flatten it into its cells) and each image (it would keep only the alt text), stood
 * in for as their own text. Opened in the editor they show as their Markdown and are written back
 * as they were, so a description with a table survives being edited. Code is left alone.
 */
function literals(
  source: string,
  stand: (node: Stand) => string | undefined,
): string {
  const lines = source.split("\n");
  let fence: string | undefined;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const opens = FENCE.exec(line);
    if (fence) {
      if (
        opens &&
        opens[1]![0] === fence[0] &&
        opens[1]!.length >= fence.length
      )
        fence = undefined;
      continue;
    }
    if (opens) {
      fence = opens[1];
      continue;
    }
    const next = lines[at + 1];
    if (line.includes("|") && next !== undefined && isTableDelimiter(next)) {
      let stop = at;
      while (
        stop < lines.length &&
        lines[stop]!.trim() &&
        lines[stop]!.includes("|")
      )
        stop++;
      for (let row = at; row < stop; row++) {
        const text = lines[row]!;
        if ([...text].some((char) => isToken(char.charCodeAt(0)))) continue;
        lines[row] = stand({ type: DOC_NODES.text, text }) ?? text;
      }
      at = stop - 1;
      continue;
    }
    lines[at] = line.replace(
      IMAGE,
      (image) => stand({ type: DOC_NODES.text, text: image }) ?? image,
    );
  }
  return lines.join("\n");
}

/** An inline block's text, where only text may go (a code block, inline code). */
export function standText(node: Stand): string {
  if (node.type === DOC_NODES.paste) return String(node.attrs?.text ?? "");
  if (node.type === DOC_NODES.mention)
    return `@${String(node.attrs?.label ?? "")}`;
  return node.text ?? "";
}

function splitTokens(text: string, stands: readonly Stand[]): DocNode[] {
  const out: DocNode[] = [];
  let run = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const node =
      char.length === 1 && isToken(code)
        ? stands[code - TOKEN_BASE]
        : undefined;
    if (!node) {
      run += char;
      continue;
    }
    if (node.type === DOC_NODES.text) {
      run += node.text;
      continue;
    }
    if (run) out.push({ type: DOC_NODES.text, text: run });
    run = "";
    out.push(JSON.parse(JSON.stringify(node)) as DocNode);
  }
  if (run) out.push({ type: DOC_NODES.text, text: run });
  return out;
}

function withMarks(node: DocNode, marks: Mark[] | undefined): DocNode {
  return marks?.length && node.type === DOC_NODES.text
    ? ({ ...node, marks } as DocNode)
    : node;
}

/** Attributes that mean something here: nulls and defaults dropped. */
function cleanAttrs(node: DocNode): Record<string, unknown> | undefined {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value === null || value === undefined) continue;
    if (key === "textAlign") continue;
    attrs[key] = value;
  }
  return Object.keys(attrs).length ? attrs : undefined;
}

const SUPPORTED_BLOCKS = new Set<string>([
  DOC_NODES.paragraph,
  RICH_NODES.heading,
  RICH_NODES.blockquote,
  RICH_NODES.bulletList,
  RICH_NODES.orderedList,
  RICH_NODES.taskList,
  RICH_NODES.listItem,
  RICH_NODES.taskItem,
  RICH_NODES.codeBlock,
  RICH_NODES.horizontalRule,
]);

/** Inline content back: stand-ins as their blocks (text where only text goes), marks kept. */
function restoreInline(nodes: DocNode[], stands: readonly Stand[]): DocNode[] {
  return nodes.flatMap((node) => {
    const marks = (node as MarkedNode).marks?.filter((mark) =>
      (MARK_ORDER as readonly string[]).includes(mark.type),
    );
    if (node.type === DOC_NODES.text) {
      const code = marks?.some((mark) => mark.type === RICH_MARKS.code);
      const text = node.text ?? "";
      if (code)
        return [
          withMarks(
            {
              type: DOC_NODES.text,
              text: [...text]
                .map((char) => {
                  const at = char.charCodeAt(0) - TOKEN_BASE;
                  const stand = isToken(char.charCodeAt(0))
                    ? stands[at]
                    : undefined;
                  return stand ? standText(stand) : char;
                })
                .join(""),
            },
            marks,
          ),
        ];
      return splitTokens(text, stands).map((part) => withMarks(part, marks));
    }
    if (node.type === RICH_NODES.hardBreak)
      return [{ type: RICH_NODES.hardBreak }];
    // An image or anything else inline the editor does not have: its text.
    const alt = String(node.attrs?.alt ?? node.attrs?.src ?? textOf(node));
    return alt ? [{ type: DOC_NODES.text, text: alt }] : [];
  });
}

/** A paragraph's lines (soft breaks, hard breaks) as paragraphs of their own. */
function splitLines(content: DocNode[]): DocNode[][] {
  const lines: DocNode[][] = [[]];
  for (const node of content) {
    if (node.type === RICH_NODES.hardBreak) {
      lines.push([]);
      continue;
    }
    if (node.type !== DOC_NODES.text || !node.text?.includes("\n")) {
      lines.at(-1)!.push(node);
      continue;
    }
    const parts = node.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ ...node, text: part });
    });
  }
  return lines.map((line) => trimLine(line));
}

/** Spaces at a line's ends, as Markdown drops them. */
function trimLine(line: DocNode[]): DocNode[] {
  const out = [...line];
  const first = out[0];
  if (first?.type === DOC_NODES.text) {
    const text = (first.text ?? "").replace(/^[ \t]+/, "");
    if (text) out[0] = { ...first, text };
    else out.shift();
  }
  const last = out.at(-1);
  if (last?.type === DOC_NODES.text) {
    const text = (last.text ?? "").replace(/[ \t]+$/, "");
    if (text) out[out.length - 1] = { ...last, text };
    else out.pop();
  }
  return out;
}

const paragraphOf = (content: DocNode[]): DocNode =>
  content.length
    ? { type: DOC_NODES.paragraph, content }
    : { type: DOC_NODES.paragraph };

function restoreBlocks(nodes: DocNode[], stands: readonly Stand[]): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    const attrs = cleanAttrs(node);
    switch (node.type) {
      case DOC_NODES.paragraph:
        return splitLines(restoreInline(node.content ?? [], stands)).map(
          paragraphOf,
        );
      case RICH_NODES.heading: {
        const level = Math.min(MAX_HEADING, Number(attrs?.level ?? 1));
        const content = restoreInline(node.content ?? [], stands).map((n) =>
          n.type === RICH_NODES.hardBreak
            ? { type: DOC_NODES.text, text: " " }
            : n,
        );
        return [
          content.length
            ? { type: RICH_NODES.heading, attrs: { level }, content }
            : { type: RICH_NODES.heading, attrs: { level } },
        ];
      }
      case RICH_NODES.codeBlock: {
        const text = [...textOf(node)]
          .map((char) => {
            const stand = isToken(char.charCodeAt(0))
              ? stands[char.charCodeAt(0) - TOKEN_BASE]
              : undefined;
            return stand ? standText(stand) : char;
          })
          .join("");
        const language = attrs?.language ? String(attrs.language) : null;
        return [
          {
            type: RICH_NODES.codeBlock,
            attrs: { language },
            ...(text ? { content: [{ type: DOC_NODES.text, text }] } : {}),
          },
        ];
      }
      case RICH_NODES.horizontalRule:
        return [{ type: RICH_NODES.horizontalRule }];
      default: {
        if (!SUPPORTED_BLOCKS.has(node.type)) {
          // A table, an image block: its text, as paragraphs.
          const text = textOf(node);
          return text
            ? normalizeNewlines(text)
                .split("\n")
                .map((line) =>
                  paragraphOf(
                    line ? [{ type: DOC_NODES.text, text: line }] : [],
                  ),
                )
            : [];
        }
        let content = restoreBlocks(node.content ?? [], stands);
        if (
          (node.type === RICH_NODES.listItem ||
            node.type === RICH_NODES.taskItem ||
            node.type === RICH_NODES.blockquote) &&
          !content.length
        )
          content = [{ type: DOC_NODES.paragraph }];
        const out: DocNode = { type: node.type };
        if (node.type === RICH_NODES.taskItem)
          out.attrs = { checked: !!attrs?.checked };
        else if (node.type === RICH_NODES.orderedList)
          out.attrs = { start: Number(attrs?.start ?? 1) };
        if (content.length) out.content = content;
        return [out];
      }
    }
  });
}

/**
 * The parser's document back as the editor's: the stand-ins of `markdownSource` as their blocks,
 * each line of a paragraph a paragraph of its own (a message's lines are lines), headings no
 * deeper than `MAX_HEADING`, and what the editor does not have (images, tables) as text.
 */
export function restoreDoc(parsed: DocNode, stands: readonly Stand[]): DocNode {
  const content = restoreBlocks(parsed.content ?? [], stands);
  return {
    type: DOC_NODES.doc,
    content: content.length ? content : [{ type: DOC_NODES.paragraph }],
  };
}

/** A document reduced to what its Markdown keeps, to compare two (`sameDoc`). */
export function comparable(doc: DocNode): unknown {
  const inline = (nodes: DocNode[]): unknown[] =>
    merge(
      nodes.flatMap((node): DocNode[] => {
        if (node.type === DOC_NODES.mention)
          return [
            {
              type: DOC_NODES.text,
              text: `@${String(node.attrs?.label ?? "")}`,
            },
          ];
        if (node.type === DOC_NODES.file) return [];
        return [node];
      }),
    ).map((node) =>
      node.type === DOC_NODES.text
        ? {
            text: node.text,
            marks: marksOf(node).map((mark) =>
              mark.type === RICH_MARKS.link
                ? `link:${String(mark.attrs?.href ?? "")}`
                : mark.type,
            ),
          }
        : node.type === DOC_NODES.paste
          ? { paste: String(node.attrs?.text ?? "") }
          : { type: node.type },
    );
  const blocks = (nodes: DocNode[]): unknown[] =>
    nodes.flatMap((node): unknown[] => {
      switch (node.type) {
        case DOC_NODES.paragraph:
          return splitLines(
            (node.content ?? []).filter((n) => n.type !== DOC_NODES.file),
          )
            .filter((line) => line.length)
            .map((line) => ({ p: inline(line) }));
        case RICH_NODES.heading:
          return [
            {
              h: Math.min(MAX_HEADING, Number(node.attrs?.level ?? 1)),
              content: inline(
                (node.content ?? []).map((n) =>
                  n.type === RICH_NODES.hardBreak
                    ? { type: DOC_NODES.text, text: " " }
                    : n,
                ),
              ),
            },
          ];
        case RICH_NODES.codeBlock:
          return [
            {
              code: textOf(node),
              language: node.attrs?.language || null,
            },
          ];
        default:
          return [
            {
              type: node.type,
              checked:
                node.type === RICH_NODES.taskItem
                  ? !!node.attrs?.checked
                  : undefined,
              start:
                node.type === RICH_NODES.orderedList
                  ? Number(node.attrs?.start ?? 1)
                  : undefined,
              content: blocks(node.content ?? []),
            },
          ];
      }
    });
  return blocks(doc.content ?? []);
}

/** Whether two documents say the same in Markdown (`comparable`). */
export function sameDoc(a: DocNode, b: DocNode): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}
