import { signal, Storage } from "nsh";

/**
 * Which transcript cards the reader opened or folded, kept by the row they were drawn from.
 *
 * A card's default is a guess: a task draft is one folded line, a task card is open. Once the reader
 * opens or folds one themselves, that choice stands, by the row's id and through a reload, It is kept on this
 * device rather than on the host, because how much of a conversation was open is a habit of a
 * screen, not of the conversation.
 */
const key = "eta.card-folds.v1";
/** Past a few hundred, the choices kept are ones no reader looks for again. */
const keep = 500;

const choices = signal<Record<string, 0 | 1>>({});
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  void Storage.getItem(key)
    .then((raw) => {
      if (!raw) return;
      const read: unknown = JSON.parse(raw);
      if (typeof read !== "object" || read === null) return;
      const saved: Record<string, 0 | 1> = {};
      for (const [id, choice] of Object.entries(read))
        if (choice === 0 || choice === 1) saved[id] = choice;
      // A choice made before storage answered is newer than what it held.
      choices.update((now) => ({ ...saved, ...now }));
    })
    .catch(() => {});
}

/** Whether the card drawn from row `id` is open: the reader's choice, else `defaultOpen`. */
export function cardOpen(id: string, defaultOpen: boolean): boolean {
  load();
  const choice = choices()[id];
  return choice === undefined ? defaultOpen : choice === 1;
}

/** Remember how the reader left the card drawn from row `id`. */
export function setCardOpen(id: string, open: boolean): void {
  load();
  const next = { ...choices() };
  delete next[id];
  next[id] = open ? 1 : 0;
  for (const stale of Object.keys(next).slice(0, -keep)) delete next[stale];
  choices.set(next);
  void Storage.setItem(key, JSON.stringify(next)).catch(() => {});
}
