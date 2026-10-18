/**
 * Conversations as the wire shows them: a row of the list, the conversation's own facts, and its
 * members. Each is a read of the database at the moment it is asked for.
 */
import type {
  ConversationInfo,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import type { ProjectStore } from "../projects/store";
import type { ConversationRecord, ConversationStore } from "./store";
import type { Timeline } from "./timeline";

export interface ViewDeps {
  conversations: ConversationStore;
  projects: ProjectStore;
  timeline: Timeline;
}

/** Who takes a message that names nobody: the conversation's own pick, else its project's. */
export function effectiveSteward(
  projects: ProjectStore,
  conversation: ConversationRecord,
): string | null {
  return (
    conversation.stewardId ??
    projects.get(conversation.projectId)?.stewardId ??
    null
  );
}

export function membersOf(
  deps: ViewDeps,
  conversationId: string,
): MemberView[] {
  const statuses = deps.timeline.memberStatuses(conversationId);
  return deps.conversations.participants(conversationId).map((member) => ({
    agentId: member.agentId,
    sessionId: member.sessionId,
    lastSeq: member.lastSeq,
    status: statuses.get(member.agentId) ?? "idle",
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
    kind: conversation.kind,
    name: conversation.name,
    archived: conversation.archived,
    stewardId: effectiveSteward(deps.projects, conversation),
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
    kind: conversation.kind,
    name: conversation.name,
    goal: conversation.goal,
    decided: conversation.decided,
    archived: conversation.archived,
    stewardId: effectiveSteward(deps.projects, conversation),
    stewardOverrideId: conversation.stewardId,
    readSeq: conversation.readSeq,
    lastSeq: conversation.lastSeq,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
