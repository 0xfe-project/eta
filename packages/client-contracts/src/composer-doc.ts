// The NSH composer's document and the clipboard rules it pastes by. The editor (nsh's
// `RichEditor`) holds the draft as a ProseMirror-shaped document: paragraphs of text with inline
// blocks among it — a folded paste, a file, a mention. Everything here is plain data, so the
// rules can be tested without an editor; the client's plugins only call them.

import type { Draft, DraftPart, PasteRange } from "./composer-draft";
import type { AttachmentView } from "./product";
import {
  charCount,
  draftFiles,
  draftWithBlocks,
  LONG_PASTE,
  MAX_MESSAGE_CHARS,
} from "./composer-draft";
import {
  hasMarkdownBlocks,
  isEditorCode,
  looksLikeMarkdown,
} from "./composer-paste";

/** A node of the editor's document, in ProseMirror's JSON shape. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
}

/** The composer schema's node names. */
export const DOC_NODES = {
  doc: "doc",
  paragraph: "paragraph",
  text: "text",
  paste: "pasteBlock",
  file: "attachment",
  mention: "mention",
} as const;

/**
 * A paste folds when it has more lines than this or more characters than `LONG_PASTE.chars`
 * (see `composer-draft`). Lines are counted as the reader sees them: the newline that ends a line
 * copied whole (VS Code, a terminal) starts no line of its own.
 */
export function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/** Whether pasted text folds into a block (`LONG_PASTE`, lines counted by `lineCount`). */
export function isLongText(text: string): boolean {
  return (
    lineCount(text) > LONG_PASTE.lines || charCount(text) > LONG_PASTE.chars
  );
}

/** Text as the composer holds it: `\r\n` (Windows) and a lone `\r` (old Mac) become `\n`. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** A file on the clipboard: what the rules need of it. */
export interface ClipboardFile {
  name: string;
  type: string;
}

/** What a paste carried, as the editor reports it. */
export interface ClipboardInput {
  text?: string;
  html?: string;
  files?: readonly ClipboardFile[];
  /** `file:` URLs of files copied in a file manager. */
  uris?: readonly string[];
}

export type ClipboardAction =
  /** Insert the files (or the copied files' URLs) as attachment blocks. */
  | { kind: "files" }
  /** Text over a message's length: it goes as a `.txt` attachment instead. */
  | { kind: "textFile"; text: string }
  /** Long text: one folded block. */
  | { kind: "block"; text: string }
  /** Code copied from an editor or an IDE (a rich editor): a code block, folded when long. */
  | { kind: "code"; text: string }
  /** Text written in Markdown (a rich editor): read as Markdown, formatted. */
  | { kind: "markdown"; text: string }
  /** Short text, typed in as plain text. */
  | { kind: "text"; text: string }
  | { kind: "nothing" };

/**
 * What a paste becomes in the composer.
 *
 * - Files win, except a picture next to text: Word, Excel, Numbers and some web pages put a
 *   rendered image of the copied text beside it, and the text is what was copied. A file manager's
 *   copy (`uris`) is always files, though it carries the names as text too.
 * - Without attachments (`files: false`), files are ignored and the text, if any, pastes.
 * - Text longer than a message can be is a `.txt` attachment, when attachments are allowed.
 * - In a rich editor (`rich`), code copied from an editor or an IDE (its HTML says so) of two
 *   lines or more is a code block, and text written in Markdown is read as Markdown: short text
 *   with any of it, long text only with a heading, a fence, a quote or a task in it (a log with
 *   dashes is still a log).
 * - Text over `LONG_PASTE` folds into a block; anything else is typed in. HTML formatting never
 *   pastes: the HTML only tells a rich copy from a plain one, and code from prose.
 */
export function classifyClipboard(
  input: ClipboardInput,
  options: { files: boolean; rich?: boolean },
): ClipboardAction {
  const text = normalizeNewlines(input.text ?? "");
  const files = input.files ?? [];
  const uris = input.uris ?? [];
  const pictureOfText =
    !uris.length &&
    files.length > 0 &&
    files.every((file) => file.type.startsWith("image/")) &&
    text.trim().length > 0;
  if (options.files && (uris.length || (files.length && !pictureOfText)))
    return { kind: "files" };
  if (!text) return { kind: "nothing" };
  if (
    options.files &&
    text.length > MAX_MESSAGE_CHARS &&
    charCount(text) > MAX_MESSAGE_CHARS
  )
    return { kind: "textFile", text };
  if (options.rich) {
    if (isEditorCode(input.html) && lineCount(text) >= 2)
      return { kind: "code", text };
    if (
      looksLikeMarkdown(text) &&
      (!isLongText(text) || hasMarkdownBlocks(text))
    )
      return { kind: "markdown", text };
  }
  if (isLongText(text)) return { kind: "block", text };
  return { kind: "text", text };
}

/** An attachment block's state, kept beside the document (the document holds only its id). */
export type UploadState =
  | { state: "uploading" }
  /** `retry`: the same bytes may be sent again (a dropped connection, not a refusal). */
  | { state: "failed"; error: string; retry?: boolean }
  | { state: "done"; attachment: AttachmentView };

/** What the composer sends, read from the document: the host's `conversations.send` fields. */
export interface SerializedDraft {
  text: string;
  blocks: PasteRange[];
  /** Mentioned member ids, in the order they appear, without repeats. */
  mentions: string[];
  /** Attachment block ids, in document order. */
  files: string[];
}

function inlineParts(node: DocNode, parts: DraftPart[], mentions: string[]) {
  switch (node.type) {
    case DOC_NODES.text:
      parts.push({ type: "text", text: node.text ?? "" });
      return;
    case "hardBreak":
      parts.push({ type: "text", text: "\n" });
      return;
    case DOC_NODES.paste:
      parts.push({
        type: "paste",
        id: String(node.attrs?.id ?? ""),
        text: String(node.attrs?.text ?? ""),
      });
      return;
    case DOC_NODES.file:
      parts.push({
        type: "file",
        id: String(node.attrs?.id ?? ""),
        name: String(node.attrs?.name ?? ""),
        contentType: String(node.attrs?.contentType ?? ""),
        size: Number(node.attrs?.size ?? 0),
      });
      return;
    case DOC_NODES.mention: {
      const id = String(node.attrs?.id ?? "");
      if (id && !mentions.includes(id)) mentions.push(id);
      parts.push({ type: "text", text: `@${String(node.attrs?.label ?? id)}` });
      return;
    }
    default:
      for (const child of node.content ?? [])
        inlineParts(child, parts, mentions);
  }
}

/** Joins neighbouring text parts, so a draft has one text part between two blocks. */
function merged(parts: DraftPart[]): Draft {
  const out: DraftPart[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (part.type === "text" && last?.type === "text")
      out[out.length - 1] = { type: "text", text: last.text + part.text };
    else if (part.type !== "text" || part.text) out.push(part);
  }
  return out;
}

/**
 * The document as a `Draft`: one text line per paragraph, a paste block as its text, a file as a
 * file part, a mention as `@label` (the text the host and the recipients read).
 */
export function docToDraft(doc: DocNode): { draft: Draft; mentions: string[] } {
  const parts: DraftPart[] = [];
  const mentions: string[] = [];
  (doc.content ?? []).forEach((block, index) => {
    if (index > 0) parts.push({ type: "text", text: "\n" });
    inlineParts(block, parts, mentions);
  });
  return { draft: merged(parts), mentions };
}

/** What goes out: the text with every paste's `PasteRange`, the mentions and the files' ids. */
export function serializeDoc(doc: DocNode): SerializedDraft {
  const { draft, mentions } = docToDraft(doc);
  return {
    ...draftWithBlocks(draft),
    mentions,
    files: draftFiles(draft).map((file) => file.id),
  };
}

function textNodes(
  text: string,
  node?: (line: string) => DocNode[],
): DocNode[][] {
  return text
    .split("\n")
    .map((line) =>
      line ? (node ? node(line) : [{ type: DOC_NODES.text, text: line }]) : [],
    );
}

/** A paragraph with `content`, or an empty one. */
function paragraph(content: DocNode[]): DocNode {
  return content.length
    ? { type: DOC_NODES.paragraph, content }
    : { type: DOC_NODES.paragraph };
}

/** A part as an inline node (text parts are split into lines by the caller). */
function partNode(part: Exclude<DraftPart, { type: "text" }>): DocNode {
  return part.type === "paste"
    ? { type: DOC_NODES.paste, attrs: { id: part.id, text: part.text } }
    : {
        type: DOC_NODES.file,
        attrs: {
          id: part.id,
          name: part.name,
          contentType: part.contentType,
          size: part.size,
        },
      };
}

/** A `Draft` as a document: text split into paragraphs at its newlines, blocks inline. */
export function draftToDoc(draft: Draft): DocNode {
  const paragraphs: DocNode[][] = [[]];
  for (const part of draft) {
    if (part.type !== "text") {
      paragraphs.at(-1)!.push(partNode(part));
      continue;
    }
    const lines = textNodes(part.text);
    paragraphs.at(-1)!.push(...lines[0]!);
    for (const line of lines.slice(1)) paragraphs.push([...line]);
  }
  return { type: DOC_NODES.doc, content: paragraphs.map(paragraph) };
}

/** Text as a document fragment to insert: its lines as paragraphs. */
export function textToNodes(text: string): DocNode[] {
  return textNodes(normalizeNewlines(text)).map(paragraph);
}

/**
 * A sent message back as a draft (a failed send pulled back to edit): its pastes folded again from
 * their ranges, its attachments as file parts after the text.
 */
export function sentToDraft(message: {
  text: string;
  blocks?: readonly PasteRange[];
  attachments: readonly AttachmentView[];
}): Draft {
  const parts: DraftPart[] = [];
  let end = 0;
  for (const [start, stop] of message.blocks ?? []) {
    if (start < end || stop > message.text.length) continue;
    parts.push({ type: "text", text: message.text.slice(end, start) });
    parts.push({
      type: "paste",
      id: `paste-${start}`,
      text: message.text.slice(start, stop),
    });
    end = stop;
  }
  parts.push({ type: "text", text: message.text.slice(end) });
  for (const file of message.attachments)
    parts.push({
      type: "file",
      id: file.id,
      name: file.name,
      contentType: file.contentType,
      size: file.size,
    });
  return merged(parts);
}

/**
 * A draft saved before the composer was a document (`eta.composer.v1`): the folded parts above the
 * box, then the box's text, the uploaded files first since that is where they showed. Read once;
 * the composer saves the document from then on.
 */
export function legacyDraftToDoc(saved: {
  text?: unknown;
  prefix?: unknown;
  attachments?: unknown;
}): { doc: DocNode; uploads: Record<string, UploadState> } {
  const uploads: Record<string, UploadState> = {};
  const parts: DraftPart[] = [];
  if (Array.isArray(saved.attachments))
    for (const file of saved.attachments as AttachmentView[]) {
      if (!file || typeof file.id !== "string") continue;
      uploads[file.id] = { state: "done", attachment: file };
      parts.push({
        type: "file",
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
      });
    }
  if (Array.isArray(saved.prefix))
    for (const part of saved.prefix as DraftPart[]) {
      if (part?.type === "text" && typeof part.text === "string")
        parts.push(part);
      else if (part?.type === "paste" && typeof part.text === "string")
        parts.push(part);
    }
  if (typeof saved.text === "string")
    parts.push({ type: "text", text: saved.text });
  return { doc: draftToDoc(merged(parts)), uploads };
}

/** Whether the document holds nothing to send: no words and no files. */
export function isBlankDoc(doc: DocNode): boolean {
  const { draft } = docToDraft(doc);
  return !draft.some((part) => part.type === "file" || part.text.trim());
}

/** The text a document stands for, blocks included (what its length limit counts). */
export function docText(doc: DocNode): string {
  return docToDraft(doc)
    .draft.map((part) => (part.type === "file" ? "" : part.text))
    .join("");
}
