import type { MemberView } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { agentName, useAgentList } from "@/queries/agents";
import { useSession, useSessionActions } from "@/queries/sessions";

/**
 * What is waiting behind the run in flight, above the composer.
 *
 * The queue belongs to a session, and a group has one per member, so a chip says whose it is as
 * soon as there is more than one lane to show. Dropping one goes through `queueRemove`, whose
 * answer is the ack: a run drains the queue at its tool boundaries, so the chip vanishing proves
 * nothing, and `already_consumed` means the message is already on its way — the chip stays until
 * the host says it was really cancelled.
 */
export function QueueChips({ members }: { members: readonly MemberView[] }) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { agents } = useAgentList();
  const { queueRemove } = useSessionActions();
  const lanes = members.flatMap((member) =>
    member.sessionId === null ? [] : [{ member, sessionId: member.sessionId }],
  );
  return (
    <div className="flex flex-col gap-1">
      {lanes.map(({ member, sessionId }) => (
        <Lane
          key={sessionId}
          sessionId={sessionId}
          who={lanes.length > 1 ? agentName(agents, member.agentId) : undefined}
          onDrop={(entryId) =>
            queueRemove.mutate({ session: sessionId, entryId })
          }
          dropped={
            queueRemove.isPending ? queueRemove.variables?.entryId : undefined
          }
          translateText={translateText}
        />
      ))}
    </div>
  );
}

function Lane({
  sessionId,
  who,
  onDrop,
  dropped,
  translateText,
}: {
  sessionId: string;
  who: string | undefined;
  onDrop: (entryId: string) => void;
  dropped: string | undefined;
  translateText: (key: string, options?: Record<string, unknown>) => string;
}) {
  const items = useSession(sessionId)?.queue?.items ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" data-slot="queue-lane">
      {items.map((item) => (
        <li
          key={item.entryId}
          data-slot="queue-chip"
          data-kind={item.kind}
          className="flex min-w-0 max-w-full items-center gap-1 border px-1.5 py-0.5 font-mono text-[11px]"
        >
          <span className="shrink-0 text-faint">
            {who === undefined ? "" : `${who} · `}
            {item.kind === "steer"
              ? translateText("chat:queue.steer")
              : translateText("chat:queue.followUp")}
          </span>
          <span className="min-w-0 truncate" title={item.text}>
            {item.text}
          </span>
          <button
            type="button"
            aria-label={translateText("chat:queue.drop", { text: item.text })}
            title={translateText("chat:queue.drop", { text: item.text })}
            disabled={dropped === item.entryId}
            onClick={() => onDrop(item.entryId)}
            className="shrink-0 px-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
