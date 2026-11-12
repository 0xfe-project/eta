/** Which conversation `/open` means by what was typed, or which of anything with an id and a name. */
import type { ConversationSummary } from "@eta/client-contracts";

/** The most names listed when what was typed could mean several. */
const NAMES_LISTED = 5;

export type NameMatch<T> =
  | { kind: "found"; item: T }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

export type OpenMatch =
  | { kind: "found"; conversation: ConversationSummary }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

/**
 * Tries, in order: the id exactly; a name equal to the query (case aside); the names starting
 * with it; the names holding it. The first try that finds anything decides: one is found, more is
 * ambiguous (with up to five names, in list order; a name more than one of them shares, case
 * aside, is followed by its id in parentheses).
 */
export function matchByName<T extends { id: string; name: string }>(
  list: readonly T[],
  query: string,
): NameMatch<T> {
  const byId = list.find((item) => item.id === query);
  if (byId !== undefined) return { kind: "found", item: byId };
  const wanted = query.toLowerCase();
  const tries: ((name: string) => boolean)[] = [
    (name) => name === wanted,
    (name) => name.startsWith(wanted),
    (name) => name.includes(wanted),
  ];
  for (const matches of tries) {
    const found = list.filter((item) => matches(item.name.toLowerCase()));
    if (found.length === 1) return { kind: "found", item: found[0]! };
    if (found.length > 1)
      return { kind: "ambiguous", names: listedNames(found) };
  }
  return { kind: "none" };
}

/** `matchByName` over conversations, as `/open` and the other commands that name one use it. */
export function matchConversation(
  list: readonly ConversationSummary[],
  query: string,
): OpenMatch {
  const match = matchByName(list, query);
  return match.kind === "found"
    ? { kind: "found", conversation: match.item }
    : match;
}

function listedNames(found: readonly { id: string; name: string }[]): string[] {
  const uses = new Map<string, number>();
  for (const item of found) {
    const name = item.name.toLowerCase();
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return found.slice(0, NAMES_LISTED).map((item) =>
    (uses.get(item.name.toLowerCase()) ?? 0) > 1
      ? // The whole id: it is what the commands take to tell the two apart.
        `${item.name} (${item.id})`
      : item.name,
  );
}
