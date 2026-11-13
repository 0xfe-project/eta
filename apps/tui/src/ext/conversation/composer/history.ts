/** The composer's history: one per conversation, kept in its state, folded pastes included. */
import type { ComposerState, Draft, FoldedPaste } from "./state";
import { emptyComposer, showDraft } from "./state";

export const MAX_HISTORY = 100;

function draftOf(state: ComposerState): Draft {
  return { text: state.text, pastes: state.pastes };
}

/**
 * Shows a history entry with the completion menu closed, so a recalled `/command` or `@name` does
 * not take ↑ ↓ from history; the menu comes back once the text changes.
 */
function showEntry(state: ComposerState, entry: Draft): ComposerState {
  return {
    ...showDraft(state, entry),
    menu: { highlight: 0, dismissed: true },
  };
}

/** After a send or a command: the text kept as the newest entry, and an empty input. */
export function afterSend(state: ComposerState): ComposerState {
  return {
    ...emptyComposer(),
    history: [...state.history, draftOf(state)].slice(-MAX_HISTORY),
  };
}

/** The entry before the one shown (the newest, when not browsing). Undefined when there is none. */
export function historyPrevious(
  state: ComposerState,
): ComposerState | undefined {
  const index = (state.browsing?.index ?? state.history.length) - 1;
  const entry = state.history[index];
  if (entry === undefined) return undefined;
  const draft = state.browsing?.draft ?? draftOf(state);
  return { ...showEntry(state, entry), browsing: { index, draft } };
}

/**
 * The entry after the one shown; past the newest, the draft from before browsing. Undefined when
 * not browsing.
 */
export function historyNext(state: ComposerState): ComposerState | undefined {
  const { browsing } = state;
  if (browsing === undefined) return undefined;
  const index = browsing.index + 1;
  const entry = state.history[index];
  if (entry === undefined)
    return { ...showDraft(state, browsing.draft), browsing: undefined };
  return {
    ...showEntry(state, entry),
    browsing: { index, draft: browsing.draft },
  };
}

function samePastes(
  a: readonly FoldedPaste[],
  b: readonly FoldedPaste[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (paste, index) =>
        paste.start === b[index]?.start &&
        paste.end === b[index]?.end &&
        paste.number === b[index]?.number &&
        paste.content === b[index]?.content,
    )
  );
}

/** The input shows a history entry exactly as it was recalled: nothing typed into it since. */
function showsRecalledEntry(state: ComposerState): boolean {
  if (state.browsing === undefined) return false;
  const entry = state.history[state.browsing.index];
  return (
    entry !== undefined &&
    entry.text === state.text &&
    samePastes(entry.pastes, state.pastes)
  );
}

/**
 * Up as history sees it. From an empty input it recalls the newest entry; on a recalled entry
 * nothing was typed into, it recalls the one before, staying on the oldest. Undefined when history
 * does not take the key: the input holds typed text, or is empty with nothing sent yet.
 */
export function historyUp(state: ComposerState): ComposerState | undefined {
  if (showsRecalledEntry(state)) return historyPrevious(state) ?? state;
  if (state.text !== "") return undefined;
  return historyPrevious({ ...state, browsing: undefined });
}

/**
 * Down as history sees it. On a recalled entry nothing was typed into, it recalls the one after,
 * and past the newest comes back to the empty input. Undefined in every other case.
 */
export function historyDown(state: ComposerState): ComposerState | undefined {
  return showsRecalledEntry(state) ? historyNext(state) : undefined;
}
