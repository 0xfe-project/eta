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
import { agentById, agents, conversations, machineById, projectById } from "../../app/lists";
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

export function groupSections(): GroupSection[] {
  const byProject = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations()) {
    if (conversation.archived || conversation.kind === "direct") continue;
    const rows = byProject.get(conversation.projectId);
    if (rows === undefined) byProject.set(conversation.projectId, [conversation]);
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
    .sort((left, right) => activityOf(right.rows[0]!) - activityOf(left.rows[0]!));
}

export interface DirectEntry {
  agent: AgentView;
  conversation: ConversationSummary | undefined;
}

export function directEntries(): DirectEntry[] {
  // Every private chat, archived ones too: an agent whose chat is put away lives in the archive.
  const chats = new Map<string, ConversationSummary>();
  for (const conversation of conversations()) {
    if (conversation.kind !== "direct") continue;
    const agentId = conversation.participants[0]?.agentId;
    if (agentId !== undefined) chats.set(agentId, conversation);
  }
  return agents()
    .flatMap((agent): DirectEntry[] => {
      const conversation = chats.get(agent.id);
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
  conversation?.participants.some((member) => member.status === "waiting_for_input") === true;

/** The segment's number: 02 and 02a count the conversations that wait for the user. */
export const waitingGroups = (): number =>
  groupSections().reduce((sum, section) => sum + section.rows.filter(waiting).length, 0);
export const waitingDirects = (): number =>
  directEntries().filter((entry) => waiting(entry.conversation)).length;

const BUSY: Exclude<MemberStatus, "idle">[] = ["waiting_for_input", "working", "stopping", "queued"];

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
    const member = conversation.participants.find((each) => each.status === status);
    if (member !== undefined) return member;
  }
  return undefined;
}

export interface StatusLine {
  text: string;
  /** Waits for the user: drawn in the foreground, not muted. */
  strong: boolean;
}

/** The line under a name. A busy member wins over the preview, which is stale by then. */
export function statusLine(conversation: ConversationSummary): StatusLine {
  const member = busiest(conversation);
  if (member !== undefined) {
    const status = t(STATUS_TEXT[member.status]);
    const name = agentById(member.agentId)?.name ?? t("conversations.deletedAgent");
    return {
      text: conversation.kind === "direct" ? status : `${name} ${status}`,
      strong: member.status === "waiting_for_input",
    };
  }
  if (conversation.preview !== "" || conversation.kind === "direct")
    return { text: conversation.preview, strong: false };
  return {
    text: t("conversations.memberCount", { count: conversation.participants.length }),
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
