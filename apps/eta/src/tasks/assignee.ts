/**
 * Who a task is for, as the registry knows it.
 *
 * An agent names the assignee the way the user did: by its id, or by its name. The task row keeps
 * the registry's id and nothing else, since that is what a run looks the executor up by; a name
 * stored as it was written is a task that cannot run. So the name is resolved where the task is
 * written, and a name that names nobody, or more than one agent, is refused there, with the
 * agents there are: guessing would hand the work to someone the user did not mean.
 */
import type { AgentRecord, AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";

export interface AssigneeScope {
  /** Allowed participant agent ids for a group conversation; undefined outside groups (e.g. Captain's chat or unlinked). */
  memberIds?: ReadonlySet<string> | undefined;
  /** Display name of the group conversation, used in error messages. */
  conversationName?: string | undefined;
}

export const CAPTAIN_ASSIGNEE_ERROR =
  "Captain cannot be assigned as a task executor (Captain coordinates work and does not run tasks)";

/**
 * Group membership scope for task assignee validation.
 *
 * Group conversations restrict task executors to current participants. Captain's own direct
 * conversation (`kind === "captain"`) and unlinked tasks impose no group-membership restriction
 * (Captain itself is always refused as an executor).
 */
export function assigneeScopeFor(
  conversationId: string | null | undefined,
  conversations: Pick<ConversationStore, "get" | "participants">,
): AssigneeScope | undefined {
  if (conversationId == null) return undefined;
  const conversation = conversations.get(conversationId);
  if (conversation?.kind !== "group") return undefined;
  return {
    memberIds: new Set(
      conversations
        .participants(conversation.id)
        .map((member) => member.agentId),
    ),
    conversationName: conversation.name,
  };
}

const formatAgents = (agents: readonly AgentRecord[]): string =>
  agents.map((a) => `${a.name} (${a.id})`).join(", ");

/**
 * The registry id of the agent `assignee` names: an id first, then Captain's reserved name
 * (always refused because Captain coordinates and never executes tasks), then a name (exact, else
 * case-insensitive) among eligible non-Captain agents. Absent or blank is no assignee.
 *
 * When `scope.memberIds` is set (for a group conversation), the resolved agent must belong to that
 * group. Captain first, because a user agent called "Captain" from before the name was reserved
 * (`checkAgentName`) is not who "Captain" means (though it remains reachable by its id).
 */
export function resolveAssignee(
  assignee: string | undefined,
  agents: Pick<AgentStore, "get" | "list">,
  scope?: AssigneeScope,
): string | undefined {
  const wanted = assignee?.trim() ?? "";
  if (wanted === "") return undefined;

  const all = agents.list();
  const captain = all.find((a) => a.systemRole === "captain");
  const nonCaptain = all.filter((a) => a.systemRole !== "captain");
  const scoped = scope?.memberIds !== undefined;
  const eligible = scoped
    ? nonCaptain.filter((a) => scope.memberIds!.has(a.id))
    : nonCaptain;

  const listedEligible = (): string => {
    if (eligible.length === 0)
      return scoped
        ? `group "${scope.conversationName ?? ""}" has no eligible members`
        : "there are no agents";
    return scoped
      ? `the group's eligible members are: ${formatAgents(eligible)}`
      : `the agents are: ${formatAgents(eligible)}`;
  };

  const checkScope = (agent: AgentRecord): string => {
    if (agent.systemRole === "captain") throw new Error(CAPTAIN_ASSIGNEE_ERROR);
    if (scoped && !scope.memberIds!.has(agent.id))
      throw new Error(
        `agent "${agent.name}" (${agent.id}) is not a member of group "${scope.conversationName ?? ""}"; ${listedEligible()}`,
      );
    return agent.id;
  };

  const byId = agents.get(wanted);
  if (byId !== undefined) return checkScope(byId);

  if (
    captain !== undefined &&
    captain.name.trim().toLowerCase() === wanted.toLowerCase()
  )
    throw new Error(CAPTAIN_ASSIGNEE_ERROR);

  let named = eligible.filter((a) => a.name.trim() === wanted);
  if (named.length === 0) {
    const folded = wanted.toLowerCase();
    named = eligible.filter((a) => a.name.trim().toLowerCase() === folded);
  }
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1)
    throw new Error(
      `more than one agent is called "${wanted}"; name the assignee by id: ${named.map((a) => a.id).join(", ")}`,
    );

  if (scoped) {
    let outside = nonCaptain.filter((a) => a.name.trim() === wanted);
    if (outside.length === 0) {
      const folded = wanted.toLowerCase();
      outside = nonCaptain.filter(
        (a) => a.name.trim().toLowerCase() === folded,
      );
    }
    if (outside.length === 1) return checkScope(outside[0]!);
    if (outside.length > 1)
      throw new Error(
        `agent "${wanted}" is not a member of group "${scope.conversationName ?? ""}"; ${listedEligible()}`,
      );
  }

  throw new Error(
    `no agent is "${wanted}" (assignee is an agent's name or id); ${listedEligible()}`,
  );
}
