// What the chat composer holds: text the user typed, with blocks among it where they pasted long
// text or files. A block is the composer's own: a long paste is folded in the box and goes out as
// the text it stands for, a file is uploaded the moment it is pasted or picked and goes out as an
// attachment of the message.

import { translate } from "@/lib/i18n";

/**
 * A paste longer than this (in characters, counted as Unicode code points,
 * or in lines) folds into a block. The composer grows to 40% of the
 * window's height, about 12 lines on a phone; 1000 characters is about a
 * screenful of code or log, past which editing it in place stops helping.
 */
export const LONG_PASTE = { chars: 1000, lines: 12 };
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
