import { createParser } from "nuqs";

/**
 * A search param that holds an id, or nothing.
 *
 * The URL can end up saying `?group=null`, and it does: a null that reached a `Link` is written
 * as the word, and from then on every link the panel draws passes it back, so it never washes
 * out. A string is truthy, so `group ?? undefined` let it through — the page asked for the
 * conversation called "null", found none, and kept the word in every URL it made after that.
 *
 * Reading the word as nothing is what stops it: no group means the panel falls back to the
 * conversation that is open, and the links it draws carry no group at all.
 */
export const idParam = createParser<string | null>({
  parse: (value) =>
    value === null || value === "" || value === "null" || value === "undefined"
      ? null
      : value,
  serialize: (value) => value ?? "",
}).withOptions({ history: "push" });
