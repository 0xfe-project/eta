/** What the view, the tab label and the commands read off a conversation's state. */
import type {
  ConversationInfo,
  ConversationSummary,
  MemberView,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { WireState } from "../../connection/types";
import type { TabStatus } from "../../extensions/types";
import type { FeedState } from "./feed/store";
import { RUNNING_STATUSES } from "./model/timeline";

/** A member as mentions and the composer's `@` menu know it. */
export interface NamedMember {
  id: string;
  name: string;
}

/** The start of an id, for an agent the list does not have. */
const ID_PREFIX = 8;

function agentName(state: Pick<FeedState, "agents">, agentId: string): string {
  return (
    state.agents.find((agent) => agent.id === agentId)?.name ??
    agentId.slice(0, ID_PREFIX)
  );
}

/** The conversation's members, named from the agent list. */
export function namedMembers(
  state: Pick<FeedState, "members" | "agents">,
): NamedMember[] {
  return state.members.map((member) => ({
    id: member.agentId,
    name: agentName(state, member.agentId),
  }));
}

/** The names of the agents whose reply is running now, each once, in row order. */
export function replyingNames(
  state: Pick<FeedState, "rows" | "agents">,
): string[] {
  const ids = state.rows
    .filter(
      (row: MessageView) =>
        row.author === "agent" &&
        row.agentId !== null &&
        RUNNING_STATUSES.has(row.status),
    )
    .map((row) => row.agentId!);
  return [...new Set(ids)].map((id) => agentName(state, id));
}

/** The eager `conversations` list as the wire holds it; empty before it arrives. */
export function conversationList(
  state: WireState,
): readonly ConversationSummary[] {
  return (
    (state.targets.conversations?.sections.list as
      | ConversationSummary[]
      | undefined) ?? []
  );
}

/** A conversation's name for its tab: from the list, else the start of its id. */
export function conversationTitle(state: WireState, id: string): string {
  return (
    conversationList(state).find((c) => c.id === id)?.name ??
    id.slice(0, ID_PREFIX)
  );
}

const RUNNING_MEMBER: ReadonlySet<MemberView["status"]> = new Set([
  "working",
  "queued",
  "stopping",
]);

/** A member waits on the user before anything else; one answering or about to makes it running. */
export function participantsStatus(
  participants: readonly MemberView[],
): TabStatus | undefined {
  if (participants.some((p) => p.status === "waiting_for_input"))
    return "waiting";
  if (participants.some((p) => RUNNING_MEMBER.has(p.status))) return "running";
  return undefined;
}

/** The tab status of a conversation in the list; undefined while it is not listed. */
export function conversationStatus(
  state: WireState,
  id: string,
): TabStatus | undefined {
  const summary = conversationList(state).find((c) => c.id === id);
  return summary === undefined
    ? undefined
    : participantsStatus(summary.participants);
}

/** The conversation's own target, as the tab follows it. */
export function conversationTarget(id: string): string {
  return `conversations.${id}`;
}

/**
 * Whether the newest agent row ended done or failed past the user's read mark. Undefined before
 * the conversation's target arrives, without an agent row, and for any other ending.
 */
function unreadEnding(state: WireState, id: string): TabStatus | undefined {
  const sections = state.targets[conversationTarget(id)]?.sections;
  const info = sections?.info as ConversationInfo | undefined;
  const timeline = sections?.timeline as TimelineSection | undefined;
  if (info === undefined || timeline === undefined) return undefined;
  const newest = timeline.messages
    .filter((row) => row.author === "agent")
    .reduce<MessageView | undefined>(
      (last, row) => (last === undefined || row.seq > last.seq ? row : last),
      undefined,
    );
  if (newest === undefined || newest.seq <= info.readSeq) return undefined;
  if (newest.status === "failed") return "failed";
  if (newest.status === "done") return "done";
  return undefined;
}

/**
 * A conversation tab's mark: running or waiting from the members in the list; otherwise done or
 * failed for an unread reply, read off the conversation's own target when the wire holds it.
 */
export function conversationTabStatus(
  state: WireState,
  id: string,
): TabStatus | undefined {
  return conversationStatus(state, id) ?? unreadEnding(state, id);
}
