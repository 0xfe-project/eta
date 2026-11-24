import type { MemberView, MessageView } from "@eta/client-contracts";
import type { Landed, Outgoing } from "./composer-draft";
import { heldFor, routeMessage } from "@eta/client-contracts/routing";
import { activeReply } from "./member-status";

/**
 * The agents a message will wait for as it goes, by the host's own routing: none when one of the
 * agents it goes to is free (it goes into the conversation), else all of them (it is held, in the
 * queue above the composer). A guess: the host's answer moves it when a reply ended or started as
 * it went.
 */
export function waitsForOf(input: {
  kind: string;
  members: readonly MemberView[];
  steward: string | null | undefined;
  mentions: readonly string[] | undefined;
}): string[] {
  const routing = routeMessage(input.kind, {
    members: input.members.map((member) => member.agentId),
    mentions: input.mentions ?? [],
    steward: input.steward ?? null,
  });
  return heldFor(routing.targets, (agentId) =>
    activeReply(
      input.members.find((member) => member.agentId === agentId)?.status ??
        "idle",
    ),
  );
}

/** A message on its way, as the reader sees it: where it is and how it is doing. */
export interface Delivery {
  message: Outgoing;
  /** In the queue above the composer, waiting for these agents; else in the transcript. */
  waitsFor: string[];
  /** Why it was not sent; it waits for the reader to retry, edit or discard it. */
  failure?: string;
  /** The host has it: it is a row of the conversation, on its way to this window. */
  landed: boolean;
}

/**
 * Every message of the outbox and every landed one whose row has not come, in the order they were
 * sent. A message whose place is not told yet (read back from an earlier run) is not shown until
 * it is.
 */
export function deliveries(input: {
  outgoing: readonly Outgoing[];
  landed: Record<string, Landed>;
  /** Ids of rows the host has shown: in the transcript or held. */
  shown: ReadonlySet<string>;
}): Delivery[] {
  const out: Delivery[] = [];
  for (const entry of Object.values(input.landed))
    if (!input.shown.has(entry.message.id))
      out.push({
        message: entry.message,
        // The host's answer, which stands over the guess.
        waitsFor: entry.held,
        landed: true,
      });
  for (const message of input.outgoing)
    if (
      message.waitsFor &&
      !input.shown.has(message.id) &&
      !out.some((entry) => entry.message.id === message.id)
    )
      out.push({
        message,
        waitsFor: message.waitsFor,
        failure: message.failure,
        landed: false,
      });
  return out.sort((a, b) => (a.message.at ?? 0) - (b.message.at ?? 0));
}

/** The row a message on its way takes at the end of the transcript, under the id the host gives it. */
export function outgoingRow(
  conversationId: string,
  message: Outgoing,
): MessageView {
  const at = message.at ?? 0;
  return {
    id: message.id,
    conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    kind: "message",
    author: "user",
    agentId: null,
    text: message.text,
    thinking: "",
    status: "done",
    revision: 0,
    mentions: message.mentions ?? [],
    rootMessageId: message.id,
    replyToId: null,
    data: {
      ...(message.attachments.length
        ? { attachments: message.attachments }
        : {}),
      ...(message.blocks?.length ? { blocks: message.blocks } : {}),
    },
    createdAt: at,
    updatedAt: at,
  };
}
