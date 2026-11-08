/**
 * What one conversation's composer holds. Plain data: the conversation's store keeps it while the
 * view is unmounted and hands it back unchanged.
 */

/**
 * A long paste folded into a placeholder. `[start, end)` is where the placeholder's label sits in
 * the composer's text (UTF-16 offsets); `content` is the pasted text it stands for.
 */
export interface FoldedPaste {
  start: number;
  end: number;
  /** The `#n` in the label. */
  number: number;
  content: string;
}

/** Text with its folded pastes: what is being written, and what each history entry keeps. */
export interface Draft {
  text: string;
  /** Sorted by `start`, never overlapping. */
  pastes: readonly FoldedPaste[];
}

export interface ComposerState extends Draft {
  /** A UTF-16 offset into `text`, on a grapheme boundary and never inside a placeholder. */
  cursor: number;
  /** What was sent or run, oldest first. */
  history: readonly Draft[];
  /** While stepping through history: the entry shown, and the draft to come back to. */
  browsing: { index: number; draft: Draft } | undefined;
  menu: {
    /** The highlighted completion, an index into what the menu lists now. */
    highlight: number;
    /** Esc closed the menu; it stays closed until the text changes. */
    dismissed: boolean;
  };
}

const FRESH_MENU: ComposerState["menu"] = { highlight: 0, dismissed: false };

export function emptyComposer(): ComposerState {
  return {
    text: "",
    pastes: [],
    cursor: 0,
    history: [],
    browsing: undefined,
    menu: FRESH_MENU,
  };
}

/** The placeholder the offset falls strictly inside, if any. */
function pasteAround(
  pastes: readonly FoldedPaste[],
  offset: number,
): FoldedPaste | undefined {
  return pastes.find((paste) => paste.start < offset && offset < paste.end);
}

/**
 * Moves the cursor to `offset`. An offset inside a placeholder goes to the placeholder's start,
 * or to its end when `towardEnd`.
 */
export function placeCursor(
  state: ComposerState,
  offset: number,
  towardEnd = false,
): ComposerState {
  const clamped = Math.max(0, Math.min(state.text.length, offset));
  const around = pasteAround(state.pastes, clamped);
  const cursor = around ? (towardEnd ? around.end : around.start) : clamped;
  if (cursor === state.cursor) return state;
  return { ...state, cursor, menu: { ...state.menu, highlight: 0 } };
}

/**
 * Replaces `[start, end)` of the text with `insert` and puts the cursor after it. The range first
 * grows to cover every placeholder it touches, so a placeholder goes whole or not at all.
 * `inserted` are placeholders inside `insert`, offsets relative to it.
 */
export function replaceRange(
  state: ComposerState,
  start: number,
  end: number,
  insert: string,
  inserted: readonly FoldedPaste[] = [],
): ComposerState {
  let from = start;
  let to = end;
  for (const paste of state.pastes) {
    if (paste.start < to && from < paste.end) {
      from = Math.min(from, paste.start);
      to = Math.max(to, paste.end);
    }
  }
  const shift = insert.length - (to - from);
  const pastes = [
    ...state.pastes.filter((paste) => paste.end <= from),
    ...inserted.map((paste) => ({
      ...paste,
      start: paste.start + from,
      end: paste.end + from,
    })),
    ...state.pastes
      .filter((paste) => paste.start >= to)
      .map((paste) => ({
        ...paste,
        start: paste.start + shift,
        end: paste.end + shift,
      })),
  ];
  return {
    ...state,
    text: state.text.slice(0, from) + insert + state.text.slice(to),
    pastes,
    cursor: from + insert.length,
    menu: FRESH_MENU,
  };
}

/** Shows `draft` in place of the text, the cursor at its end; history and browsing stay. */
export function showDraft(state: ComposerState, draft: Draft): ComposerState {
  return {
    ...state,
    text: draft.text,
    pastes: draft.pastes,
    cursor: draft.text.length,
    menu: FRESH_MENU,
  };
}
