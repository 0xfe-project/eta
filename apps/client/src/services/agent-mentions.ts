import type { MentionRef } from "@eta/client-contracts/composer-markdown";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import { useHost } from "./host";

/** Every agent as text names them (`@label`): the mentions of text not in a chat (a task's
 * description, a routine's report, release notes). */
export function useAgentMentions(): () => MentionRef[] {
  const host = useHost();
  return () => {
    const named = host.agents().map((agent) => ({
      id: agent.id,
      name: agent.name,
    }));
    return named.map((agent) => ({
      id: agent.id,
      label: mentionLabel(agent, named),
    }));
  };
}
