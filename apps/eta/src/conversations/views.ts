/**
 * Conversations as the wire shows them: a row of the list, the conversation's own facts, and its
 * members. Each is a read of the database at the moment it is asked for.
 */
import type {
  ConversationInfo,
  ConversationKind,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import type { ConversationRecord, ConversationStore } from "./store";
import type { Timeline } from "./timeline";

export interface ViewDeps {
  conversations: ConversationStore;
  timeline: Timeline;
}

/**
 * What a group is called when nobody named it: the project it lives in, so a second group in the
 * same project is a second row with the same name. Only a project with no name at all falls back
 * to its members, because a group with an empty name is a row nobody can tell apart.
 */
export function defaultGroupName(
  projectName: string,
  memberNames: readonly (string | undefined)[],
): string {
  if (projectName !== "") return projectName;
  return memberNames.filter((name) => name !== undefined).join(", ");
}

export function membersOf(
  deps: ViewDeps,
  conversationId: string,
): MemberView[] {
  const activity = deps.timeline.memberActivity(conversationId);
  return deps.conversations.participants(conversationId).map((member) => ({
    agentId: member.agentId,
    sessionId: member.sessionId,
    lastSeq: member.lastSeq,
    ...(activity.get(member.agentId) ?? { status: "idle" }),
  }));
}

export function summaryOf(
  deps: ViewDeps,
  conversation: ConversationRecord,
): ConversationSummary {
  const digest = deps.timeline.digest(conversation.id, conversation.readSeq);
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    kind: conversation.kind as ConversationKind,
    name: conversation.name,
    archived: conversation.archived,
    stewardId: conversation.stewardId,
    participants: membersOf(deps, conversation.id),
    lastSeq: conversation.lastSeq,
    readSeq: conversation.readSeq,
    unread: digest.unread,
    preview: digest.preview,
    lastMessageAt: digest.lastMessageAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function infoOf(
  deps: ViewDeps,
  conversation: ConversationRecord,
): ConversationInfo {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    kind: conversation.kind as ConversationKind,
    name: conversation.name,
    goal: conversation.goal,
    decided: conversation.decided,
    archived: conversation.archived,
    stewardId: conversation.stewardId,
    readSeq: conversation.readSeq,
    lastSeq: conversation.lastSeq,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
