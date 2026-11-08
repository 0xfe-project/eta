/** Which conversation `/open` means by what was typed. */
import type { ConversationSummary } from "@eta/client-contracts";

/** The most names listed when what was typed could mean several conversations. */
const NAMES_LISTED = 5;
export type OpenMatch =
  | { kind: "found"; conversation: ConversationSummary }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

/**
 * Tries, in order: the id exactly; a name equal to the query (case aside); the names starting
 * with it; the names holding it. The first try that finds anything decides: one conversation is
 * found, more is ambiguous (with up to five names, in list order).
 */
export function matchConversation(
  list: readonly ConversationSummary[],
  query: string,
): OpenMatch {
  const byId = list.find((c) => c.id === query);
  if (byId !== undefined) return { kind: "found", conversation: byId };
  const wanted = query.toLowerCase();
  const tries: ((name: string) => boolean)[] = [
    (name) => name === wanted,
    (name) => name.startsWith(wanted),
    (name) => name.includes(wanted),
  ];
  for (const matches of tries) {
    const found = list.filter((c) => matches(c.name.toLowerCase()));
    if (found.length === 1) return { kind: "found", conversation: found[0]! };
    if (found.length > 1)
      return { kind: "ambiguous", names: listedNames(found) };
  }
  return { kind: "none" };
}

/**
 * The first five names, in list order. A name more than one of them shares (case aside) is
 * followed by its id in parentheses.
 */
function listedNames(found: readonly ConversationSummary[]): string[] {
  const uses = new Map<string, number>();
  for (const c of found) {
    const name = c.name.toLowerCase();
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return found.slice(0, NAMES_LISTED).map((c) =>
    (uses.get(c.name.toLowerCase()) ?? 0) > 1
      ? // The whole id: it is what `/open` takes to tell the two apart.
        `${c.name} (${c.id})`
      : c.name,
  );
}
