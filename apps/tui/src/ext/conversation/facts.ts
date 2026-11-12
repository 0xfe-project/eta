/** What the view, the tab label and the commands read off a conversation's state. */
import type {
  ConversationSummary,
  MemberView,
  MessageView,
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
