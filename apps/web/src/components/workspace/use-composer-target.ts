import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import type { StickyTarget } from "@/lib/mentions";
import { composerTarget } from "@/lib/mentions";
import { agentName } from "@/queries/agents";
import { useWorkspaceStore } from "./workspace-store";

/**
 * Who this conversation's next message reaches, and the group's memory of it. Everything that acts
 * on the composer reads `targetOf`, so what the button says is what happens. A direct chat has one
 * reader and no choice, so it keeps nothing.
 */
export function useComposerTarget(
  group: ConversationSummary | undefined,
  agents: readonly Pick<AgentView, "id" | "name">[],
) {
  const conversationId = group?.kind === "direct" ? undefined : group?.id;
  const sticky = useWorkspaceStore((state) =>
    conversationId === undefined
      ? undefined
      : state.workspace.stickyTargets?.[conversationId],
  );
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace);
  const stewardId = conversationId === undefined ? null : group?.stewardId;
  const steward =
    stewardId === null || stewardId === undefined
      ? undefined
      : { id: stewardId, name: agentName(agents, stewardId) };
  const members = (group?.participants ?? []).map((member) => ({
    id: member.agentId,
    name: agentName(agents, member.agentId),
  }));
  return {
    steward,
    targetOf: (text: string) =>
      composerTarget({ text, members, steward, sticky }),
    remember: (next: StickyTarget | undefined) => {
      if (conversationId === undefined) return;
      setWorkspace((workspace) => {
        const others = Object.entries(workspace.stickyTargets ?? {}).filter(
          ([id]) => id !== conversationId,
        );
        return {
          ...workspace,
          stickyTargets: Object.fromEntries(
            next === undefined ? others : [...others, [conversationId, next]],
          ),
        };
      });
    },
  };
}
