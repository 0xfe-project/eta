import type { AgentView, MessageView } from "@eta/client-contracts";
import type { KeyboardEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConversationActions } from "@/queries/conversations";

/** More names than this read as a list nobody reads: say "them" instead. */
const MAX_NAMES = 3;

/** The agents a held message waits for (`data.woke`), as one phrase. */
function waitingNames(
  message: MessageView,
  agents: readonly AgentView[],
  them: string,
  separator: string,
): string {
  const ids = Array.isArray(message.data.woke)
    ? (message.data.woke as string[])
    : [];
  if (ids.length === 0 || ids.length > MAX_NAMES) return them;
  return ids
    .map((id) => agents.find((agent) => agent.id === id)?.name ?? them)
    .join(separator);
}

/**
 * Messages that are written but not in the conversation yet, over the box that would have sent
 * them: one bordered block each, as wide as the box, the text at the size of the conversation's
 * and cut at two lines (the whole of it on hover).
 *
 * They are held because every lane that would answer them was busy: nothing read them, so they are
 * not part of the record and the transcript never shows them. Three things can be done with one,
 * and each waits for the host to say it happened:
 *
 * - insert it into the turn in flight (`steerHeld`, what `/steer` would have done). The host takes
 *   it out of the queue and joins in one step, so a lane that read it first means it is not sent
 *   again, and the block only says so;
 * - pull it back into the box, or drop it (`recall`). A lane that picked it up first makes `recall`
 *   answer false, and then the words are already in the conversation: putting them back in the box
 *   would say them twice.
 *
 * With a block focused, ⌘/Ctrl+Enter inserts, E pulls back and Delete drops.
 */
export function HeldMessages({
  conversationId,
  held,
  agents,
  onPullBack,
}: {
  conversationId: string;
  held: readonly MessageView[];
  agents: readonly AgentView[];
  /** Put the message's text back above whatever is being typed. */
  onPullBack: (text: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { recall, steerHeld } = useConversationActions();
  const [busy, setBusy] = useState<{
    id: string;
    steering: boolean;
  } | null>(null);

  const namesOf = (message: MessageView) =>
    waitingNames(
      message,
      agents,
      translateText("chat:queue.them"),
      translateText("chat:queue.separator"),
    );

  const take = async (messageId: string) => {
    setBusy({ id: messageId, steering: false });
    try {
      const answer = await recall.mutateAsync({ conversationId, messageId });
      return answer.recalled;
    } catch {
      // No answer is not a win: recalling again is free, a duplicated message is not.
      return false;
    } finally {
      setBusy(null);
    }
  };

  const steer = async (message: MessageView) => {
    const names = namesOf(message);
    setBusy({ id: message.id, steering: true });
    try {
      const answer = await steerHeld.mutateAsync({
        conversationId,
        messageId: message.id,
      });
      if (answer.steered) return;
      toast.message(
        translateText(
          answer.reason === "idle"
            ? "chat:queue.steerIdle"
            : answer.reason === "ended"
              ? "chat:queue.steerEnded"
              : "chat:queue.steerTaken",
          { names },
        ),
      );
    } catch (error) {
      toast.error(
        translateText("chat:queue.steerFailed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const pullBack = (message: MessageView) =>
    void take(message.id).then((recalled) => {
      if (recalled) onPullBack(message.text);
    });

  if (held.length === 0) return null;
  return (
    <ul className="grid gap-1.5" data-slot="held-lane">
      {held.map((message, index) => {
        const names = namesOf(message);
        const several =
          Array.isArray(message.data.woke) && message.data.woke.length > 1;
        const mine = busy?.id === message.id;
        const steering = mine && busy?.steering === true;
        const disabled = mine;
        const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
          if (disabled) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void steer(message);
          } else if (
            (event.key === "e" || event.key === "E") &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            pullBack(message);
          } else if (event.key === "Delete") {
            event.preventDefault();
            void take(message.id);
          }
        };
        return (
          <li
            key={message.id}
            data-slot="held-message"
            data-state={steering ? "steering" : undefined}
            tabIndex={0}
            aria-busy={disabled || undefined}
            aria-label={translateText("chat:queue.label", {
              text: message.text,
            })}
            onKeyDown={onKeyDown}
            className="min-w-0 border outline-none focus-visible:border-ring"
          >
            <div
              data-slot="held-head"
              className={cn(
                "flex items-center gap-2 px-2.5 pt-1.5 text-xs",
                steering ? "text-state-info" : "text-muted-foreground",
              )}
            >
              {steering ? (
                <span className="inline-flex items-center gap-1.5">
                  <i
                    aria-hidden="true"
                    className="size-1.5 animate-pulse bg-current"
                  />
                  {translateText("chat:queue.steering", { names })}
                </span>
              ) : (
                <>
                  <span>
                    {translateText("chat:queue.followUp")}
                    {" · "}
                    {index === 0
                      ? translateText("chat:queue.afterTurn", { names })
                      : translateText("chat:queue.afterPrevious")}
                  </span>
                  <span className="flex-1" />
                  {held.length > 1 ? (
                    <span className="tabular-nums">
                      {index + 1} / {held.length}
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <p
              data-slot="held-text"
              title={message.text}
              className="line-clamp-2 px-2.5 pt-0.5 text-[14px] leading-[1.6] break-words whitespace-pre-wrap"
            >
              {message.text}
            </p>
            <div className="flex items-center gap-0.5 px-0.5 pt-0.5 pb-1.5">
              <button
                type="button"
                data-slot="held-steer"
                disabled={disabled}
                aria-label={translateText("chat:queue.steer", {
                  text: message.text,
                })}
                onClick={() => void steer(message)}
                className="px-2 py-0.5 text-[12.5px] text-foreground underline underline-offset-3 disabled:opacity-40"
              >
                {translateText(
                  several
                    ? "chat:queue.steerActionSeveral"
                    : "chat:queue.steerAction",
                )}
              </button>
              <button
                type="button"
                data-slot="held-pull"
                disabled={disabled}
                aria-label={translateText("chat:queue.pullBack", {
                  text: message.text,
                })}
                onClick={() => pullBack(message)}
                className="px-2 py-0.5 text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                {translateText("chat:queue.pullBackAction")}
              </button>
              <span className="flex-1" />
              <button
                type="button"
                data-slot="held-drop"
                disabled={disabled}
                aria-label={translateText("chat:queue.drop", {
                  text: message.text,
                })}
                onClick={() => void take(message.id)}
                className="px-2 py-0.5 text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                {translateText("chat:queue.dropAction")}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
