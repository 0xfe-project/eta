/** Pasting into the composer: folding long pastes, and expanding them again for sending. */
import type { PasteRange } from "../contract";
import type { ComposerState, Draft } from "./state";
import { insertText } from "./editing";
import { replaceRange } from "./state";

/** A paste folds when it has more lines or more characters (code points) than this. */
export const LONG_PASTE = { lines: 5, chars: 800 };

export function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

function isLongPaste(text: string): boolean {
  return (
    lineCount(text) > LONG_PASTE.lines || [...text].length > LONG_PASTE.chars
  );
}

export function placeholderLabel(number: number, lines: number): string {
  return `[Pasted text #${number} +${lines} lines]`;
}

/** Puts a paste in at the cursor: folded into a placeholder when it is long, else as written. */
export function pasteText(state: ComposerState, raw: string): ComposerState {
  const text = normalizePaste(raw);
  if (text === "") return state;
  if (!isLongPaste(text)) return insertText(state, text);
  const number = Math.max(0, ...state.pastes.map((paste) => paste.number)) + 1;
  const label = placeholderLabel(number, lineCount(text));
  return replaceRange(state, state.cursor, state.cursor, label, [
    { start: 0, end: label.length, number, content: text },
  ]);
}

/**
 * The draft as it is sent: every placeholder replaced by its paste, the whole trimmed the way the
 * host trims what it stores, and where each paste sits in that trimmed text. A paste that starts
 * or ends in spaces at the edge of the draft loses them with the trim, and its range is cut to
 * match.
 */
export function outgoing(draft: Draft): { text: string; pastes: PasteRange[] } {
  let text = "";
  let copied = 0;
  const ranges: PasteRange[] = [];
  for (const paste of draft.pastes) {
    text += draft.text.slice(copied, paste.start);
    ranges.push([text.length, text.length + paste.content.length]);
    text += paste.content;
    copied = paste.end;
  }
  text += draft.text.slice(copied);
  const trimmed = text.trim();
  const lead = text.length - text.trimStart().length;
  const pastes = ranges.flatMap(([start, end]): PasteRange[] => {
    const from = Math.max(0, start - lead);
    const to = Math.min(trimmed.length, end - lead);
    return from < to ? [[from, to]] : [];
  });
  return { text: trimmed, pastes };
}
