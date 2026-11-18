/**
 * What the search page offers: the path as typed when it can be opened, then the recent places
 * that match, then what the machine found, each place once.
 *
 * Adapted from Paseo (`packages/app/src/utils/working-directory-suggestions.ts` and
 * `buildProjectPickerOptions`, commit `b24eab7`, Apache License 2.0; see `./LICENSE`). The
 * machine's matches come already ranked with the same `scorePathMatch`; the client only filters
 * what it remembers with it, and keeps the remembered order.
 */
import type { PathFlavor, PlaceRef } from "./types";
import { scorePathMatch } from "./match";
import { isOpenablePath } from "./openable";

export type Suggestion<T extends PlaceRef> =
  | { kind: "typed"; path: string }
  | { kind: "recent"; place: T }
  | { kind: "found"; place: T };

/** For matching: `scorePathMatch` ignores case whatever the machine. */
const normalized = (value: string): string =>
  value.trim().replace(/\\/g, "/").toLowerCase();

/**
 * Whether a machine's filesystem treats `/Home` and `/home` as one: Windows and macOS by default,
 * not Linux and the other Unixes. `os` is the machine's `process.platform`.
 */
export function foldsCase(
  os: string | null | undefined,
  flavor: PathFlavor,
): boolean {
  return flavor === "win32" || os === "win32" || os === "darwin";
}

/**
 * A remembered place matches by what a person sees of it (`~/…`), not by the home's own path,
 * which would match whatever is in the home's name.
 */
function recentMatches(place: PlaceRef, query: string): boolean {
  const q = normalized(query);
  if (q === "~" || q === "~/") return true;
  return scorePathMatch(q, normalized(place.display)) !== null;
}

export function buildSuggestions<T extends PlaceRef>(input: {
  query: string;
  flavor: PathFlavor;
  /** The machine's `process.platform`: whether a typed path equals a listed one ignoring case. */
  os?: string | null | undefined;
  recent: readonly T[];
  found: readonly T[];
}): Suggestion<T>[] {
  const query = input.query.trim();
  const seen = new Set<string>();
  const out: Suggestion<T>[] = [];
  const add = (kind: "recent" | "found", place: T) => {
    if (seen.has(place.path)) return;
    seen.add(place.path);
    out.push({ kind, place } as Suggestion<T>);
  };
  for (const place of input.recent)
    if (query === "" || recentMatches(place, query)) add("recent", place);
  if (query !== "") for (const place of input.found) add("found", place);
  if (!isOpenablePath(query, input.flavor)) return out;
  // The same place, by the machine's rules: on Linux `/home` is not `/Home`, and a typed `/home`
  // must stay openable even when only `/Home` was found.
  const fold = foldsCase(input.os, input.flavor);
  const same = (value: string): string => {
    const text = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return fold ? text.toLowerCase() : text;
  };
  const typed = same(query);
  const listed = out.some(
    (entry) =>
      entry.kind !== "typed" &&
      (same(entry.place.display) === typed || same(entry.place.path) === typed),
  );
  return listed ? out : [{ kind: "typed", path: query }, ...out];
}

/**
 * The directories the recent places are in, each once, most recent first: where a clone or a new
 * directory is likely to go, as Paseo offers the parents of its projects.
 */
export function parentsOf(
  places: readonly { parent: PlaceRef | null }[],
): PlaceRef[] {
  const seen = new Set<string>();
  const out: PlaceRef[] = [];
  for (const { parent } of places) {
    if (parent === null || seen.has(parent.path)) continue;
    seen.add(parent.path);
    out.push(parent);
  }
  return out;
}
