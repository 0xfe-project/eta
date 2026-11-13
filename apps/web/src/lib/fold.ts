import { useSyncExternalStore } from "react";

/**
 * Which cards the reader has opened and folded, kept by the row they were drawn from.
 *
 * A card's default is a guess the page makes from the thing around it: a task draft is one folded
 * line from the moment its row exists, and a task card is open until the reader says otherwise. A guess
 * is no match for a choice, so from the moment the reader opens or folds a card themselves that
 * stands — here, by the row's id, and through a reload. A card with no choice of its own follows the
 * guess, which can still move under it while its turn finishes.
 *
 * It is `localStorage` and not the server because how wide something was open on this screen is a
 * habit of this browser, for the same reason the pane widths are (see `components/workspace/pane.ts`):
 * the same conversation on a laptop and on a wide monitor need not agree on what was open.
 */

/** Where the choices are kept. */
const STORAGE_KEY = "eta.card-folds.v1";
/**
 * How many choices to remember. A row's fold matters while the row is being read; past a few hundred
 * the choices kept are ones no reader will look for again.
 */
const KEEP = 500;

/** The last text read from storage, and what it parsed to. */
let raw: string | undefined;
let parsed: Record<string, 0 | 1> = {};

/** The choices as storage holds them now: parsed once, and re-parsed only when it changed. */
function choices(): Record<string, 0 | 1> {
  let text: string | null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode, or storage denied: nothing is remembered, and nothing is written either.
    return parsed;
  }
  if (text === raw) return parsed;
  parsed = {};
  raw = text ?? "";
  try {
    const read: unknown = JSON.parse(text ?? "{}");
    if (typeof read === "object" && read !== null) {
      for (const [id, choice] of Object.entries(read as object)) {
        if (choice === 0 || choice === 1) parsed[id] = choice;
      }
    }
  } catch {
    // A value this version did not write: start from nothing said rather than fail to draw.
  }
  return parsed;
}

/**
 * Who is drawing a fold. One row can be drawn twice at once — a boxed reply's answer sits under the
 * process and again in the dialog that opens the whole process — and the reader expects the two to
 * be one fold. Every hook listening hears about every choice made, and re-reads its own row's.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the reader left this card open, or `undefined` when they never said. */
export function foldChoice(id: string): boolean | undefined {
  const choice = choices()[id];
  return choice === undefined ? undefined : choice === 1;
}

/** Say how the reader left it, dropping what was heard first once past the cap. */
export function rememberFold(id: string, open: boolean): void {
  const known = choices();
  known[id] = open ? 1 : 0;
  for (const stale of Object.keys(known).slice(0, -KEEP)) delete known[stale];
  try {
    raw = JSON.stringify(known);
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Not persisted; the choice still holds for this visit, in what `known` now holds.
  }
  for (const listener of listeners) listener();
}

/**
 * A fold the reader owns: `[open, fold]`, where `open` is their choice when they have made one and
 * `defaultOpen` until they do, and `fold` both applies the choice and remembers it.
 *
 * `defaultOpen` can still move, and a card that has heard no opinion follows it. One that has
 * does not. Nothing is held in the component: the store is the answer, so the same row drawn in
 * two places shows one fold and changes as one.
 */
const nothingSaid = () => undefined;

export function useFold(
  id: string,
  defaultOpen: boolean,
): [boolean, (open: boolean) => void] {
  const choice = useSyncExternalStore(
    subscribe,
    () => foldChoice(id),
    nothingSaid,
  );
  return [choice ?? defaultOpen, (next: boolean) => rememberFold(id, next)];
}
// CI timing probe
