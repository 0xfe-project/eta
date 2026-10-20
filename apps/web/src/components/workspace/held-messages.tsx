import type { MessageView } from "@eta/client-contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConversationActions } from "@/queries/conversations";

/**
 * Messages that are written but not in the conversation yet, over the box that would have sent
 * them.
 *
 * They are held because every lane that would answer them was busy: nothing read them, so they are
 * not part of the record and the transcript never shows them. Recall is the only thing to do with
 * one, and it has two shapes — "pull back" puts the words back in the box, "drop" does not — but
 * both are the same removal, and both wait for the host to say it happened. A lane that picked the
 * message up first makes `recall` answer false, and then the words are already in the conversation:
 * putting them back in the box would say them twice.
 */
export function HeldMessages({
  conversationId,
  held,
  onPullBack,
}: {
  conversationId: string;
  held: readonly MessageView[];
  /** Put the message's text back above whatever is being typed. */
  onPullBack: (text: string) => void;
}) {
  const { t: translateText } = useTranslation(["chat"] as const);
  const { recall } = useConversationActions();
  const [busy, setBusy] = useState<string | null>(null);

  const take = async (messageId: string) => {
    setBusy(messageId);
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

  if (held.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" data-slot="held-lane">
      {held.map((message) => (
        <li
          key={message.id}
          data-slot="held-chip"
          className="flex min-w-0 max-w-full items-center gap-1 border px-1.5 py-0.5 font-mono text-[11px]"
        >
          <span className="shrink-0 text-faint">
            {translateText("chat:queue.followUp")}
          </span>
          <span className="min-w-0 truncate" title={message.text}>
            {message.text}
          </span>
          <button
            type="button"
            aria-label={translateText("chat:queue.pullBack", {
              text: message.text,
            })}
            title={translateText("chat:queue.pullBack", { text: message.text })}
            disabled={busy === message.id}
            onClick={() =>
              void take(message.id).then((recalled) => {
                if (recalled) onPullBack(message.text);
              })
            }
            className="shrink-0 px-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {translateText("chat:queue.pullBackAction")}
          </button>
          <button
            type="button"
            aria-label={translateText("chat:queue.drop", {
              text: message.text,
            })}
            title={translateText("chat:queue.drop", { text: message.text })}
            disabled={busy === message.id}
            onClick={() => void take(message.id)}
            className="shrink-0 px-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
