// The two lists as data, as the web sidebar builds them: a group is a place, so groups sit under
// their project; a private chat is a relationship, so every agent has a row, with its chat if any.

import type {
  AgentStatus,
  AgentView,
  ConversationSummary,
  MemberStatus,
  MemberView,
} from "@eta/client-contracts";
import type { TextKey } from "../../i18n";
import { agentOnlyChat } from "@eta/client-contracts";
import {
  agentById,
  agents,
  conversations,
  machineById,
  projectById,
} from "../../app/lists";
import { t } from "../../i18n";

export const activityOf = (conversation: ConversationSummary): number =>
  conversation.lastMessageAt ?? conversation.updatedAt;

const newestFirst = (left: ConversationSummary, right: ConversationSummary) =>
  activityOf(right) - activityOf(left);

export interface GroupSection {
  projectId: string;
  /** Undefined once the project is gone. */
  project: string | undefined;
  machine: string | undefined;
  rows: ConversationSummary[];
}

/**
 * The agent whose own chat this is, when it is one: a group of one, in that agent's home project.
 *
 * The project is part of the question, and `agentOnlyChat` leaves it out on purpose: a group that
 * is down to one member in somebody else's project is still that project's group, and its agent's
 * row is a different conversation. It is also where `makeAgentChat` makes the agent's chat, so the
 * row, the press and the screen all agree on which conversation this is.
 */
export function ownChatAgent(
  conversation: ConversationSummary | undefined,
): AgentView | undefined {
  if (conversation === undefined) return undefined;
  const agent = agentById(conversation.participants[0]?.agentId);
  if (agent === undefined) return undefined;
  if (conversation.projectId !== agent.homeProjectId) return undefined;
  return agentOnlyChat(conversation, agent.id) ? agent : undefined;
}

/**
 * The chat an agent already has: the newest of them, and a chat that is still open over one that was
 * put away, whatever their times say — pressing the agent opens that one rather than making another.
 * Undefined until somebody talks to it.
 */
export function ownChatOf(agent: AgentView): ConversationSummary | undefined {
  let found: ConversationSummary | undefined;
  for (const conversation of conversations()) {
    if (ownChatAgent(conversation)?.id !== agent.id) continue;
    if (found === undefined) {
      found = conversation;
      continue;
    }
    if (found.archived !== conversation.archived) {
      if (found.archived) found = conversation;
      continue;
    }
    if (newestFirst(conversation, found) < 0) found = conversation;
  }
  return found;
}

export function groupSections(): GroupSection[] {
  const byProject = new Map<string, ConversationSummary[]>();
  // A chat of one agent is that agent's row, not a place: what the 私聊 segment claims is out of
  // the groups, so no conversation is drawn twice and none is left out.
  for (const conversation of conversations()) {
    if (conversation.archived || ownChatAgent(conversation) !== undefined)
      continue;
    const rows = byProject.get(conversation.projectId);
    if (rows === undefined)
      byProject.set(conversation.projectId, [conversation]);
    else rows.push(conversation);
  }
  return [...byProject.entries()]
    .map(([projectId, rows]) => {
      const project = projectById(projectId);
      return {
        projectId,
        project: project?.name,
        machine: machineById(project?.machineId)?.name,
        rows: rows.sort(newestFirst),
      };
    })
    .sort(
      (left, right) => activityOf(right.rows[0]!) - activityOf(left.rows[0]!),
    );
}

export interface DirectEntry {
  agent: AgentView;
  conversation: ConversationSummary | undefined;
}

export function directEntries(): DirectEntry[] {
  // Every agent's own chat, archived ones too: an agent whose chat is put away lives in the
  // archive, and offering the agent again as one nobody has talked to was the same row twice.
  return agents()
    .flatMap((agent): DirectEntry[] => {
      const conversation = ownChatOf(agent);
      return conversation?.archived === true ? [] : [{ agent, conversation }];
    })
    .sort((left, right) => {
      if (left.conversation === undefined || right.conversation === undefined) {
        if (left.conversation !== right.conversation)
          return left.conversation === undefined ? 1 : -1;
        return left.agent.createdAt - right.agent.createdAt;
      }
      return newestFirst(left.conversation, right.conversation);
    });
}

export const archivedConversations = (): ConversationSummary[] =>
  conversations()
    .filter((conversation) => conversation.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt);

const waiting = (conversation: ConversationSummary | undefined): boolean =>
  conversation?.participants.some(
    (member) => member.status === "waiting_for_input",
  ) === true;

/** The segment's number: 02 and 02a count the conversations that wait for the user. */
export const waitingGroups = (): number =>
  groupSections().reduce(
    (sum, section) => sum + section.rows.filter(waiting).length,
    0,
  );
export const waitingDirects = (): number =>
  directEntries().filter((entry) => waiting(entry.conversation)).length;

const BUSY: Exclude<MemberStatus, "idle">[] = [
  "waiting_for_input",
  "working",
  "stopping",
  "queued",
];

const STATUS_TEXT: Record<MemberStatus, TextKey> = {
  idle: "conversations.status.idle",
  queued: "conversations.status.queued",
  working: "conversations.status.working",
  waiting_for_input: "conversations.status.waiting",
  stopping: "conversations.status.stopping",
};

/** The member a row speaks of: whoever waits for the user first, then whoever is at work. */
function busiest(conversation: ConversationSummary): MemberView | undefined {
  for (const status of BUSY) {
    const member = conversation.participants.find(
      (each) => each.status === status,
    );
    if (member !== undefined) return member;
  }
  return undefined;
}

export interface StatusLine {
  text: string;
  /** Waits for the user: drawn in the foreground, not muted. */
  strong: boolean;
}

/**
 * The line under a name. A busy member wins over the preview, which is stale by then.
 *
 * A chat of one agent names nobody ("等待确认", not "小满 等待确认"): the agent is already the
 * row's title. A group's row names whoever is busy, even when only one member is left.
 */
export function statusLine(conversation: ConversationSummary): StatusLine {
  const member = busiest(conversation);
  const own = ownChatAgent(conversation) !== undefined;
  if (member !== undefined) {
    const status = t(STATUS_TEXT[member.status]);
    const name =
      agentById(member.agentId)?.name ?? t("conversations.deletedAgent");
    return {
      text: own ? status : `${name} ${status}`,
      strong: member.status === "waiting_for_input",
    };
  }
  if (conversation.preview !== "" || own)
    return { text: conversation.preview, strong: false };
  return {
    text: t("conversations.memberCount", {
      count: conversation.participants.length,
    }),
    strong: false,
  };
}

/** An agent nobody has talked to has no chat to speak of, only itself. */
export function agentLine(agent: AgentView): StatusLine {
  return {
    text: t(STATUS_TEXT[agent.status satisfies AgentStatus]),
    strong: agent.status === "waiting_for_input",
  };
}
