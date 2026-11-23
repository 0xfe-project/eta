import type { RichEditorRef, RichEditorSession } from "nsh/base";

// nsh's RichEditor takes typing through an invisible native field at the caret (the "sink"). It
// reads only the sink's text: each change is diffed against what the sink held by common prefix,
// and the difference is replayed at the editor's caret as Backspaces and typed text. Where the
// sink's own caret is never reaches the editor. An input method that pairs brackets (types
// "（）" and puts its caret between them, as on macOS) therefore leaves the editor's caret after
// "）" while the input method types between them: the next character arrives as "Backspace, then
// 中）", so it lands between the brackets while the caret stays drawn after them (#366).
//
// The app cannot read the sink either, so it follows what the document shows: a pair committed in
// one go, with the caret still after it a moment later, gets the caret between its halves; a
// change that deleted the text before the caret and typed it again behind new text gets the caret
// after the new text. Both go through the view's `setSelection`, which also empties the sink, so
// what is typed next is inserted at the caret the editor draws.

/** The caret and the textblock it is in: the block's first position and its text. */
interface Around {
  head: number;
  start: number;
  text: string;
}

/**
 * Pairs input methods type together (Chinese punctuation's auto-pairing), opening half first. Not
 * ASCII ones: Linux reports quick typing as one change, so "()" typed by hand could read as a pair.
 */
const PAIRS = new Set([
  "（）",
  "【】",
  "《》",
  "〈〉",
  "「」",
  "『』",
  "〔〕",
  "［］",
  "｛｝",
  "“”",
  "‘’",
]);

/** How far back a replay can reach: what the sink held after a pair, and some text typed since. */
const REACH = 16;

/**
 * After the sink replayed its change (Backspaces, then the new text followed by the text they
 * deleted): where the caret belongs, after the new text. Null when the change reads as plain
 * typing at the caret, or as anything else.
 */
export function retypedCaret(before: Around, after: Around): number | null {
  if (before.start !== after.start) return null;
  const grown = after.text.length - before.text.length;
  const at = before.head - before.start;
  if (grown <= 0 || after.head - after.start !== at + grown) return null;
  const typedAt = (back: number) =>
    before.text.slice(0, at - back) +
    after.text.slice(at - back, at - back + grown) +
    before.text.slice(at - back);
  if (typedAt(0) === after.text) return null;
  for (let back = 1; back <= Math.min(at, REACH); back++)
    if (typedAt(back) === after.text) return after.start + at - back + grown;
  return null;
}

/**
 * A bracket pair typed in one go at the caret, with the caret left after it: its middle. Null
 * for anything else.
 */
export function pairMiddle(before: Around, after: Around): number | null {
  if (before.start !== after.start) return null;
  const at = before.head - before.start;
  if (after.head - after.start !== at + 2) return null;
  const pair = after.text.slice(at, at + 2);
  if (!PAIRS.has(pair)) return null;
  if (after.text !== before.text.slice(0, at) + pair + before.text.slice(at))
    return null;
  return after.head - 1;
}

/** How long a pair's caret waits for an input method that moves it with an arrow key itself. */
const PAIR_WAIT_MS = 60;

/** What an inline leaf reads as here: U+FFFC, the object replacement character. */
const LEAF = "\uFFFC";

/** The caret's textblock, when the selection is a caret in text. */
function around(session: RichEditorSession): Around | null {
  const selection = session.selection;
  if (
    selection.type !== "text" ||
    selection.head === undefined ||
    selection.anchor !== selection.head
  )
    return null;
  const head = selection.head;
  try {
    const at = session.resolve(head) as { start: number; end: number };
    const block = session.nodeAt(at.start - 1);
    // A text counts its UTF-16 length in positions, as a JS string does; an inline leaf (a
    // mention, a file's chip, a line break) one position, which one stand-in character keeps.
    const text = (block?.content ?? [])
      .map((node) => (node.type === "text" ? (node.text ?? "") : LEAF))
      .join("");
    if (text.length !== at.end - at.start) return null;
    return { head, start: at.start, text };
  } catch {
    return null;
  }
}

const same = (a: Around | null, b: Around | null) =>
  !!a && !!b && a.head === b.head && a.start === b.start && a.text === b.text;

/**
 * Keeps the editor's caret with the input method's (see above). `view` is the editor's view while
 * one shows it; `composing` whether an input method is composing (a pair's caret then stays: the
 * document waits for the commit, and the next change is the replay's to fix). Returns what stops
 * it.
 */
export function followSinkCaret(
  session: RichEditorSession,
  view: () => RichEditorRef | undefined,
  composing: () => boolean,
): () => void {
  let settled = around(session);
  /** The origins of the changes since `settled`. */
  let origins: string[] = [];
  let flush: ReturnType<typeof setTimeout> | undefined;
  let pairTimer: ReturnType<typeof setTimeout> | undefined;
  const place = (pos: number) => {
    const ref = view();
    if (!ref) return;
    ref.setSelection(pos, pos);
  };
  const settle = () => {
    flush = undefined;
    const changes = origins;
    origins = [];
    const before = settled;
    const now = around(session);
    settled = now;
    if (!before || !now || !changes.length) return;
    // Typing only: the sink's replay is the view's Backspaces ("api") and the typed text.
    if (!changes.includes("input")) return;
    if (changes.some((origin) => origin !== "input" && origin !== "api"))
      return;
    const retyped = retypedCaret(before, now);
    if (retyped !== null) {
      place(retyped);
      return;
    }
    const middle = changes.every((origin) => origin === "input")
      ? pairMiddle(before, now)
      : null;
    if (middle === null) return;
    clearTimeout(pairTimer);
    pairTimer = setTimeout(() => {
      pairTimer = undefined;
      // An input method that moves its caret with an arrow key moved the editor's too, and
      // anything typed since is the replay's to fix: only a caret still where the pair left it.
      if (!flush && !composing() && same(around(session), now)) place(middle);
    }, PAIR_WAIT_MS);
  };
  // Events come in JS's next turn, after the state moved on: the state is read once the turn's
  // events are in, and what changed is told by the transactions between two reads.
  const stop = session.on("transaction", (value) => {
    const tr = value as { docChanged?: boolean; origin?: string };
    if (tr.docChanged) origins.push(tr.origin ?? "");
    clearTimeout(flush);
    flush = setTimeout(settle, 0);
  });
  return () => {
    stop();
    clearTimeout(flush);
    clearTimeout(pairTimer);
  };
}
