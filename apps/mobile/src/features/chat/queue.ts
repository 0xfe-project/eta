// Who is waiting, said near the composer and never as a row of the transcript (03, 03a, 03g).

import type { MemberStatus, MessageView } from "@eta/client-contracts";
import { conversations } from "../../app/lists";
import { t } from "../../i18n";
import { agentName } from "./conversation";
import { ACTIVE_STATUSES, RUNNING_STATUSES } from "./rows";

const BUSY: ReadonlySet<MemberStatus> = new Set([
  "working",
  "waiting_for_input",
  "stopping",
]);

/** The conversation an agent is answering in from another session than `session`. Reactive. */
export function answeringElsewhere(
  agentId: string,
  id: string,
  session: string | undefined,
): string | undefined {
  return conversations().find(
    (conversation) =>
      conversation.id !== id &&
      conversation.participants.some(
        (member) =>
          member.agentId === agentId &&
          member.sessionId !== session &&
          BUSY.has(member.status),
      ),
  )?.name;
}

export interface QueueLine {
  agentId: string;
  text: string;
}

/** One line for each member with a reply waiting, its newest. Reactive. */
export function queueLines(
  messages: readonly MessageView[],
  id: string,
  sessionOf: (agentId: string) => string | undefined,
): QueueLine[] {
  const replies = messages.filter(
    (row) =>
      row.author === "agent" &&
      row.agentId !== null &&
      ACTIVE_STATUSES.has(row.status),
  );
  const newest = new Map<string, MessageView>();
  for (const row of replies)
    if (row.status === "queued") newest.set(row.agentId ?? "", row);
  return [...newest.entries()].map(([agentId, row]) => {
    const ahead = replies.filter(
      (other) => other.agentId === agentId && other.seq < row.seq,
    ).length;
    const name = agentName(agentId);
    const group = answeringElsewhere(agentId, id, sessionOf(agentId));
    const running = replies.find(
      (other) =>
        other.agentId !== agentId && RUNNING_STATUSES.has(other.status),
    );
    const text =
      ahead > 0
        ? t("chat.queue.ahead", { count: ahead })
        : group !== undefined
          ? t("chat.queue.elsewhere", { group })
          : running !== undefined
            ? t("chat.queue.waitingFor", {
                name,
                other: agentName(running.agentId),
              })
            : t("chat.queue.queued", { name });
    return { agentId, text };
  });
}
