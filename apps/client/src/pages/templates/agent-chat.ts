import type { AgentView, ConversationResults } from "@eta/client-contracts";
import type { useHost } from "../../services/host";
import { showToast } from "../../components/toast";
import { localizedText } from "../../i18n";

/**
 * The private chat of an agent just made: a group of its own in its home project, with the agent
 * as its only member and its steward. Returns the conversation to open; when the host refuses, the
 * toast says why (the agent is made either way) and nothing opens.
 */
export async function openAgentChat(
  host: ReturnType<typeof useHost>,
  agent: AgentView,
): Promise<string | undefined> {
  try {
    const { conversation } = await host.call<ConversationResults["create"]>(
      "conversations",
      "create",
      {
        projectId: agent.homeProjectId,
        agentIds: [agent.id],
        stewardId: agent.id,
      },
    );
    return conversation.id;
  } catch (problem) {
    showToast({
      title: localizedText(
        `${agent.name} is made, but its chat could not be opened`,
        `${agent.name} 已创建，但无法打开它的对话`,
      ),
      body: problem instanceof Error ? problem.message : String(problem),
      tone: "red",
    });
    return undefined;
  }
}
