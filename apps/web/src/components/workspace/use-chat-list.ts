import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import { useMemo } from "react";
import { projectPlace } from "@/lib/projects";
import { useAgentList } from "@/queries/agents";
import { useMachines, useProjects } from "@/queries/projects";
import { useGroups } from "./use-groups";

/**
 * The sidebar's two sections, as data.
 *
 * A group and a private chat are different things and are laid out as such: a group is a place —
 * a directory, some agents, a piece of work — and a private chat is a relationship with one agent.
 * One list ordered by activity alone made time the only axis, so the group someone works in all
 * day kept moving down under the agents they said hello to.
 */

/** The groups that run in one directory, newest activity first. */
export interface DirectoryGroup {
  projectId: string;
  /**
   * Where it runs (see projectPlace), when the project is still there to say: `short` for the card,
   * `full` for when someone asks for the whole of it.
   */
  place: { short: string; full: string } | undefined;
  conversations: ConversationSummary[];
  /** The newest activity inside: what sorts the directories among themselves. */
  at: number;
}

/** One agent, with its private chat when it has one. */
export interface AgentEntry {
  agent: AgentView;
  conversation: ConversationSummary | undefined;
  /** Its chat's activity, else when the agent was made: one nobody has opened sorts by that. */
  at: number;
}

const activityOf = (conversation: ConversationSummary) =>
  conversation.lastMessageAt ?? conversation.updatedAt;

export function useChatList() {
  const { groups, current } = useGroups();
  const { agents, loaded } = useAgentList();
  const { projects } = useProjects();
  const { machines } = useMachines();

  const directories = useMemo<DirectoryGroup[]>(() => {
    const open = groups.filter(
      (conversation) =>
        !conversation.archived && conversation.kind !== "direct",
    );
    const byProject = new Map<string, ConversationSummary[]>();
    for (const conversation of open) {
      const list = byProject.get(conversation.projectId);
      if (list === undefined)
        byProject.set(conversation.projectId, [conversation]);
      else list.push(conversation);
    }
    return [...byProject.entries()]
      .map(([projectId, conversations]) => {
        const sorted = [...conversations].sort(
          (left, right) => activityOf(right) - activityOf(left),
        );
        const project = projects.find((each) => each.id === projectId);
        return {
          projectId,
          place:
            project === undefined
              ? undefined
              : {
                  short: projectPlace(project, machines, { short: true }),
                  full: projectPlace(project, machines),
                },
          conversations: sorted,
          at: sorted[0] === undefined ? 0 : activityOf(sorted[0]),
        };
      })
      .sort((left, right) => right.at - left.at);
  }, [groups, projects, machines]);

  const directs = useMemo<AgentEntry[]>(() => {
    // Every private chat, archived ones included: an agent that has one is represented by it.
    const chats = new Map<string, ConversationSummary>();
    for (const conversation of groups) {
      if (conversation.kind !== "direct") continue;
      const agentId = conversation.participants[0]?.agentId;
      if (agentId !== undefined) chats.set(agentId, conversation);
    }
    return agents
      .filter((a) => a.systemRole !== "captain")
      .flatMap((agent): AgentEntry[] => {
        const conversation = chats.get(agent.id);
        // A chat that is put away takes the agent with it: the archived list is the only place it
        // lives, and offering the agent again as one nobody has talked to was the same row twice.
        if (conversation?.archived === true) return [];
        return [
          {
            agent,
            conversation,
            at:
              conversation === undefined
                ? agent.createdAt
                : activityOf(conversation),
          },
        ];
      })
      .sort((left, right) => {
        // A chat is a thing that happened; an agent nobody has talked to is not. Those go after
        // the ones with activity, in the order they were made — a list that reshuffled whenever
        // someone created an agent would be a list you re-read every time.
        const leftHas = left.conversation !== undefined;
        const rightHas = right.conversation !== undefined;
        if (leftHas !== rightHas) return leftHas ? -1 : 1;
        return leftHas
          ? right.at - left.at
          : left.agent.createdAt - right.agent.createdAt;
      });
  }, [groups, agents]);

  return { directories, directs, current, loaded };
}
