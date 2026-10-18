// What the chat composer holds: text the user typed, with blocks among it where they pasted long
// text. A block is the composer's own: a long paste is folded in the box and goes out as the text
// it stands for. (Files are not here: the host has nowhere to put an attachment yet.)

/**
 * A paste longer than this (in characters, counted as Unicode code points,
 * or in lines) folds into a block. The composer grows to 40% of the
 * window's height, about 12 lines on a phone; 1000 characters is about a
 * screenful of code or log, past which editing it in place stops helping.
 */
export const LONG_PASTE = { chars: 1000, lines: 12 };
/** A message's text at most. */
export const MAX_MESSAGE_CHARS = 100_000;

export type DraftPart =
  | { type: "text"; text: string }
  /** Long text pasted as a block; sent as the text itself. */
  | { type: "paste"; id: string; text: string };
export type Draft = DraftPart[];

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

/** The draft's text, blocks of pasted text included: what is sent. */
export function draftText(draft: Draft) {
  return draft.map((p) => p.text).join("");
}

export function isBlank(draft: Draft) {
  return !draftText(draft).trim();
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
