import { cleanup, Clipboard, effect, keymap, signal } from "nsh";

/** A selection in a shown text: whose it is, when it was made and the text as it reads. */
interface ShownSelection {
  owner: object;
  /** Its place among the selections made (`selectionMade`). */
  made: number;
  read: () => string;
}

const current = signal<ShownSelection | undefined>(undefined);
let made = 0;

/** A number for a selection made now, larger than every earlier one's. */
export const selectionMade = () => ++made;

/**
 * The text selected last in a shown text (a message, a reply, a description), while it stays
 * selected. An editor elsewhere in the window can keep the keyboard focus while the user selects
 * there (the chat's composer above all). On macOS, ⌘C then goes to that editor, which copies only
 * its own selection (nothing, with only a caret there). So the editor copies this one when it was
 * made after the editor's own (`copyAround` in ./editor). nsh's plain `Input` does this itself;
 * its `RichEditor` does not (#385).
 */
export const shownSelection = () => current();

/** Called by a shown text when its selection changes; `text` empty means it has none now. */
export function selectShown(owner: object, text: string, read: () => string) {
  if (text) current.set({ owner, made: selectionMade(), read });
  else forgetShown(owner);
}

/** The shown text `owner` has no selection any more (it changed or it is gone). */
function forgetShown(owner: object) {
  if (current()?.owner === owner) current.set(undefined);
}

/**
 * A shown text's part in copying: while its selection is the current one, ⌘C / Ctrl+C copies
 * it as it reads, wherever the focus is, except in a text input (an editor copies it itself, in
 * `copyAround`). On macOS a view that takes the focus on a press (the chat's transcript, a stop of
 * the keyboard focus) has it once the user selected in a reply, and the platform's Copy then
 * copies nothing. The key goes on to the platform as well (whose copy this one replaces once it is
 * written). Its selection is forgotten when the text goes.
 */
export function takeShownCopies(owner: object) {
  effect(() => {
    const shown = current();
    if (shown?.owner !== owner) return;
    return keymap.bind(
      "mod+c",
      () => void Clipboard.writeText(shown.read()).catch(() => {}),
      { passThrough: true },
    );
  });
  cleanup(() => forgetShown(owner));
}
