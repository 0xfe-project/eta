/** What the management commands read off the wire's eager lists. */
import type {
  ConversationSummary,
  MachineView,
  ProjectView,
} from "@eta/client-contracts";
import type { WireState } from "../../connection/types";
import { agentsOf, machinesOf, projectsOf } from "../../extensions/eager-lists";
import { conversationList } from "../conversation/facts";
import { ordinaryAgents } from "../kit/captain";

/** The start of an id, for an agent the list does not have. */
const ID_PREFIX = 8;

export function summaryOf(
  state: WireState,
  id: string,
): ConversationSummary | undefined {
  return conversationList(state).find((c) => c.id === id);
}

/** An agent as the commands show and match it. */
export interface NamedAgent {
  id: string;
  name: string;
}

/** The conversation's members in list order, named from the agent list. */
export function membersOf(
  state: WireState,
  summary: ConversationSummary | undefined,
): NamedAgent[] {
  const agents = agentsOf(state);
  return (summary?.participants ?? []).map(({ agentId }) => ({
    id: agentId,
    name:
      agents.find((agent) => agent.id === agentId)?.name ??
      agentId.slice(0, ID_PREFIX),
  }));
}

/** The agents that are not members of the conversation, in agent list order. */
export function outsidersOf(
  state: WireState,
  summary: ConversationSummary | undefined,
): NamedAgent[] {
  const members = new Set(summary?.participants.map((p) => p.agentId));
  return ordinaryAgents(agentsOf(state))
    .filter((agent) => !members.has(agent.id))
    .map(({ id, name }) => ({ id, name }));
}

/** The projects a conversation can start in, the most recently updated first. */
export function startableProjects(state: WireState): ProjectView[] {
  return projectsOf(state)
    .filter((project) => project.kind === "project" && !project.archived)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function primaryMachine(state: WireState): MachineView | undefined {
  return machinesOf(state).find((machine) => machine.kind === "primary");
}
