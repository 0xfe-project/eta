import type { MemberView } from "@eta/client-contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { agentName, useAgentList } from "@/queries/agents";
import { useSession, useSessionActions } from "@/queries/sessions";

/**
 * What is waiting behind the run in flight, over the box that would have sent it.
 *
 * A queue belongs to a session and a group has one per member, so a chip says whose it is as soon
 * as there is more than one lane. Three things can be done with an entry, and all three start the
 * same way: take it out of its lane and wait for the host to say what happened. A run drains the
 * queue at its tool boundaries, so "the chip is gone" proves nothing — `already_consumed` means the
 * message is already on its way, and doing anything else then would send it a second time.
 */
export function QueueChips({
  members,
  onPullBack,
  onSend,
}: {
  members: readonly MemberView[];
  /** Put the entry's text back above whatever is being typed. */
  onPullBack: (text: string) => void;
  onSend: (text: string, mode: "steer") => void;
}) {
  const { queueRemove } = useSessionActions();
  const { agents } = useAgentList();
  const [busy, setBusy] = useState<string | null>(null);
  const lanes = members.flatMap((member) =>
    member.sessionId === null ? [] : [{ member, sessionId: member.sessionId }],
  );

  /** Take one entry out, and say whether it was still there to take. */
  const take = async (sessionId: string, entryId: string) => {
    setBusy(entryId);
    try {
      const answer = await queueRemove.mutateAsync({
        session: sessionId,
        entryId,
      });
      return answer.outcome === "cancelled";
    } catch {
      // No answer is not a win: every one of these can be done again, a duplicated send cannot.
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {lanes.map(({ member, sessionId }) => (
        <Lane
          key={sessionId}
          sessionId={sessionId}
          who={lanes.length > 1 ? agentName(agents, member.agentId) : undefined}
          busy={busy}
          onDrop={(entryId) => void take(sessionId, entryId)}
          onSteer={(entryId, text) =>
            void take(sessionId, entryId).then((cancelled) => {
              if (cancelled) onSend(text, "steer");
            })
          }
          onPullBack={(entryId, text) =>
            void take(sessionId, entryId).then((cancelled) => {
              if (cancelled) onPullBack(text);
            })
          }
        />
      ))}
    </div>
  );
}

function Lane({
  sessionId,
  who,
  busy,
  onDrop,
  onSteer,
  onPullBack,
}: {
  sessionId: string;
  who: string | undefined;
  busy: string | null;
  onDrop: (entryId: string) => void;
  onSteer: (entryId: string, text: string) => void;
  onPullBack: (entryId: string, text: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
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
          {/* A steered entry cannot be steered again: taking it out and putting it back as a
              steer is the same state, so the button would be a lie. */}
          {item.kind === "followUp" ? (
            <button
              type="button"
              aria-label={translateText("chat:queue.steerOne", {
                text: item.text,
              })}
              title={translateText("chat:queue.steerOne", { text: item.text })}
              disabled={busy === item.entryId}
              onClick={() => onSteer(item.entryId, item.text)}
              className="shrink-0 px-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {translateText("chat:queue.steerAction")}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={translateText("chat:queue.pullBack", {
              text: item.text,
            })}
            title={translateText("chat:queue.pullBack", { text: item.text })}
            disabled={busy === item.entryId}
            onClick={() => onPullBack(item.entryId, item.text)}
            className="shrink-0 px-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {translateText("chat:queue.pullBackAction")}
          </button>
          <button
            type="button"
            aria-label={translateText("chat:queue.drop", { text: item.text })}
            title={translateText("chat:queue.drop", { text: item.text })}
            disabled={busy === item.entryId}
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
