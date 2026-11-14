// What the chat composer holds: text the user typed, with blocks among it where they pasted long
// text or files. A block is the composer's own: a long paste is folded in the box and goes out as
// the text it stands for, a file is uploaded the moment it is pasted or picked and goes out as an
// attachment of the message.

import { translate } from "@/lib/i18n";

/**
 * A paste longer than this (in characters, counted as Unicode code points,
 * or in lines) folds into a block. What you paste you already know is a lump —
 * a few lines of log or someone else's paragraph is not something to type into
 * the middle of a sentence — so the bar is low: more than three lines and it
 * becomes the chip. 1000 characters is where a single-line paste stops being
 * something you can see the shape of while editing it.
 */
export const LONG_PASTE = { chars: 1000, lines: 3 };
/** A message's text at most. */
export const MAX_MESSAGE_CHARS = 100_000;
/** A paste too long to send as text goes as a file of this name. */
export const pasteFileName = () => translate("chat:attachments.pastedFileName");

export type DraftPart =
  | { type: "text"; text: string }
  /** Long text pasted as a block; sent as the text itself. */
  | { type: "paste"; id: string; text: string }
  /** A file being, or already, uploaded (its state is in the outbox's uploads). */
  | {
      type: "file";
      id: string;
      name: string;
      contentType: string;
      size: number;
    };
export type Draft = DraftPart[];
export type FilePart = Extract<DraftPart, { type: "file" }>;

export const EMPTY_DRAFT: Draft = [];

export function charCount(text: string) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function isLongPaste(text: string) {
  return (
    text.split("\n").length > LONG_PASTE.lines ||
    charCount(text) > LONG_PASTE.chars
  );
}

export function plainDraft(text: string): Draft {
  return text ? [{ type: "text", text }] : [];
}

/** The draft's text, blocks of pasted text included: what is sent. Files are not text. */
export function draftText(draft: Draft) {
  return draft.map((p) => (p.type === "file" ? "" : p.text)).join("");
}

/**
 * Where a folded paste sits in the text that goes out: `[start, end)` as **UTF-16 offsets**
 * into that text — the unit `String.prototype.slice` counts in, so a renderer holding the
 * same text can cut each block out and show the chip the composer showed. The same pairs go
 * out on the wire (`conversations.send`'s `blocks`) and come back on the row (`data.blocks`);
 * the host records them without looking at them.
 */
export type PasteRange = [start: number, end: number];

/**
 * `draftText` with the place of every paste block in it, for the message's `data.blocks`.
 * The text comes out trimmed — the host trims what it stores, and the row is what a renderer
 * slices — so the ranges are cut from the leading whitespace with it and agree with the row
 * on every index. (Leading whitespace only exists when a typed part comes first, so no range
 * overlaps it; trailing whitespace only exists after the last block, so no range is clipped.)
 */
export function draftWithBlocks(draft: Draft): {
  text: string;
  blocks: PasteRange[];
} {
  let text = "";
  const blocks: PasteRange[] = [];
  for (const part of draft) {
    if (part.type === "file") continue;
    if (part.type === "paste")
      blocks.push([text.length, text.length + part.text.length]);
    text += part.text;
  }
  const trimmed = text.trim();
  const lead = text.length - text.trimStart().length;
  return {
    text: trimmed,
    blocks: blocks.map(
      ([start, end]) => [start - lead, end - lead] as PasteRange,
    ),
  };
}

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

/** The files in a draft, in order. */
export function draftFiles(draft: Draft): FilePart[] {
  return draft.filter((p): p is FilePart => p.type === "file");
}

/** Nothing to send: no words and no files. */
export function isBlank(draft: Draft) {
  return !draftFiles(draft).length && !draftText(draft).trim();
}

/** The text after a slash command's name. */
export function afterCommand(text: string, name: string): string {
  return text.slice(name.length).trim();
}

/** A sent message's text back as a draft, to edit and send again: long text as a block again. */
export function draftOf(text: string): Draft {
  return isLongPaste(text)
    ? [{ type: "paste", id: crypto.randomUUID(), text }]
    : plainDraft(text);
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
