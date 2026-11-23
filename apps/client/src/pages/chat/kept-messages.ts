import type { MessageView } from "@eta/client-contracts";

/**
 * Keeps each message the object it was while nothing in it changes.
 *
 * The host sends a changed timeline whole, so every update parses every
 * message anew. On the web, nsh's `<List>` tells kept rows from replaced ones
 * by object identity alone (its native hosts match rows by `keyExtractor`):
 * given all new objects it replaces every row, forgets their measured
 * heights and lays the list out again from `estimatedItemSize`, moving the
 * scroll position with it. The page jumped each time a reply started or
 * ended. Handing the list the same objects again leaves only the rows that
 * did change to be replaced.
 */
export function keptMessages() {
  let kept = new Map<string, { json: string; message: MessageView }>();
  return (messages: MessageView[]) => {
    const next = new Map<string, { json: string; message: MessageView }>();
    const result = messages.map((message) => {
      const json = JSON.stringify(message);
      const before = kept.get(message.id);
      const same = before?.json === json ? before.message : message;
      next.set(message.id, { json, message: same });
      return same;
    });
    kept = next;
    return result;
  };
}
