/** The composer's history: one per conversation, kept in its state, folded pastes included. */
import type { ComposerState, Draft } from "./state";
import { emptyComposer, showDraft } from "./state";

export const MAX_HISTORY = 100;

function draftOf(state: ComposerState): Draft {
  return { text: state.text, pastes: state.pastes };
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
  return { ...showDraft(state, entry), browsing: { index, draft } };
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
    ...showDraft(state, entry),
    browsing: { index, draft: browsing.draft },
  };
}
