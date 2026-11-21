import type { MessageView } from "@eta/client-contracts";

/**
 * A message waiting for a lane is not in the conversation yet, and neither is the reply queued for
 * it: the composer's chip is where the whole thing belongs until a lane takes it. The host leaves
 * the message out of its window, but not the reply rows waiting under it (they carry no `held` of
 * their own). A queued reply draws the member's live run, so every one of them left in the list
 * would show the same process window again.
 *
 * Only a reply whose message is the one waiting is dropped: a message already in the transcript
 * with a member still busy keeps its waiting line.
 */
export function withoutHeldReplies(
  rows: MessageView[],
  held: MessageView[],
): MessageView[] {
  if (held.length === 0) return rows;
  const waiting = new Set(held.map((row) => row.id));
  return rows.filter(
    (row) => row.author !== "agent" || !waiting.has(row.rootMessageId ?? ""),
  );
}
