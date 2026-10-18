import type { MessageView } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";
import { agentName, useAgentList } from "@/queries/agents";

/**
 * A system row: something that happened to the conversation, not something said in it.
 *
 * The host writes these in English, for the agents that read them at their next wake; the page
 * says them in the reader's language from the event they record (`steward`, `wake_budget`), and
 * shows the row's own text for an event it does not know.
 */
export function GroupNotice({ message }: { message: MessageView }) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  const { agents } = useAgentList();
  const { event, from, to, budget } = message.data as {
    event?: string;
    from?: string | null;
    to?: string | null;
    budget?: number;
  };
  let text = message.text;
  if (event === "steward") {
    if (typeof to === "string" && typeof from === "string")
      text = translateText("chat:system.stewardChanged", {
        to: agentName(agents, to),
        from: agentName(agents, from),
      });
    else if (typeof to === "string")
      text = translateText("chat:system.stewardSet", {
        to: agentName(agents, to),
      });
    else if (typeof from === "string")
      text = translateText("chat:system.stewardCleared", {
        from: agentName(agents, from),
      });
  } else if (event === "wake_budget" && typeof budget === "number") {
    text = translateText("chat:system.wakeBudget", { budget });
  }
  return (
    <div className="system-message">
      <p>{text}</p>
    </div>
  );
}
