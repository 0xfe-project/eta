/**
 * The product's wire shapes (REFACTOR.md §9, P2.4).
 *
 * These are AXP's shapes, not ours, and that is the point: the existing web reads them, and its
 * types come from the control plane's OpenAPI document. Keeping our own rows and translating on
 * the way out means two things stay true at once — the web works, and our storage is not shaped
 * by what a client happens to want today.
 *
 * Where the two vocabularies differ, the translation says so:
 *
 *   our `working` reply        AXP's `responding`
 *   our `done` reply           AXP's `completed`
 *   our message `text`         AXP's `blocks: [{ type: "text", text }]`
 *   our author kinds           AXP's `role` (user | assistant) plus `kind` (message | mention | …)
 */
import type { AgentRecord } from "../agents/store";
import type {
  GroupRecord,
  MessageRecord,
  ParticipantRecord,
} from "../groups/store";
import type { InteractionRecord } from "../interactions/store";

export interface AxpBlock {
  type: "text";
  text: string;
}

export interface AxpMessage {
  group_id: string;
  seq: number;
  kind: "message" | "mention" | "system" | "task_draft" | "task_card";
  data: Record<string, unknown>;
  id: string;
  /** Empty for the user's own messages. */
  agent_id: string;
  role: "user" | "assistant";
  reply_to_id: string | null;
  status:
    | "queued"
    | "responding"
    | "waiting_for_input"
    | "stopping"
    | "completed"
    | "stopped"
    | "failed";
  revision: number;
  blocks: AxpBlock[];
  failure: { message: string } | null;
  created_at: string;
}

export interface AxpParticipant {
  agent_id: string;
  member: boolean;
  name: string;
  status: string;
}

export interface AxpGroup {
  id: string;
  name: string;
  kind: "group" | "direct";
  goal: string;
  decided: string;
  archived: boolean;
  read_seq: number;
  last_seq: number;
  unread: number;
  preview: string;
  revision: number;
  last_message_at: string | null;
  updated_at: string;
  participants: AxpParticipant[];
}

export interface AxpAgent {
  id: string;
  name: string;
  /** The agent's instructions, which AXP calls the description. */
  description: string;
  model: string | null;
  /** The bundles it is built from; ours are plugin names (P3 owns what they mean). */
  bundles: string[];
  status: "idle" | "starting" | "working" | "waiting_for_input" | "unavailable";
  build_error: string | null;
  revision: number;
}

export interface AxpInteractionOption {
  value: string;
  label: string;
}

/**
 * A confirmation card, as the web reads it.
 *
 * `kind` is always `choice`: a question with options is the only shape the ask channel has, and one
 * asked without options is a choice with none.
 */
export interface AxpInteraction {
  group_id: string;
  id: string;
  agent_id: string;
  message_id: string;
  kind: "choice";
  prompt: string;
  options: AxpInteractionOption[];
  status: "pending" | "resolved" | "expired";
  revision: number;
  /** The option the user chose; null until it is answered. */
  answer: string | null;
  created_at: string;
  updated_at: string;
}

export interface AxpSnapshot {
  groups: AxpGroup[];
  agents: AxpAgent[];
  /** The replies that are running right now, which the web shows as "working". */
  active_replies: AxpMessage[];
  /** The confirmation cards still waiting for an answer (P2.6). */
  interactions: AxpInteraction[];
  /** Where the stream resumes from: the hub's own sequence, as a string. */
  event_cursor: string;
}

const STATUS: Record<MessageRecord["status"], AxpMessage["status"]> = {
  queued: "queued",
  working: "responding",
  waiting_for_input: "waiting_for_input",
  done: "completed",
  failed: "failed",
  // AXP spells these two the same way we do, which is where the words came from.
  stopping: "stopping",
  stopped: "stopped",
};

const KIND: Record<string, AxpMessage["kind"]> = {
  user: "message",
  assistant: "message",
  mention: "mention",
  system: "system",
  task_draft: "task_draft",
  task_card: "task_card",
};

/** One timeline row as the web reads it. */
export function toMessage(message: MessageRecord): AxpMessage {
  const role: AxpMessage["role"] =
    message.authorKind === "user" ? "user" : "assistant";
  return {
    group_id: message.groupId,
    seq: message.seq,
    kind: KIND[message.kind] ?? "message",
    data: {},
    id: message.id,
    agent_id: message.authorAgentId ?? "",
    role,
    // `root_message_id` is what AXP calls the message a reply answers.
    // A reply points at the user message it answers; a user message has no parent. (Ours stores a
    // root message as its own root, which would read as a message replying to itself.)
    reply_to_id: role === "user" ? null : (message.rootMessageId ?? null),
    status: STATUS[message.status],
    revision: message.revision,
    blocks:
      message.text.length === 0 ? [] : [{ type: "text", text: message.text }],
    // A failed reply carries its reason where the web expects to find it.
    failure: message.status === "failed" ? { message: message.text } : null,
    created_at: message.createdAt,
  };
}

function toParticipant(
  participant: ParticipantRecord,
  name: string,
): AxpParticipant {
  return {
    agent_id: participant.agentId,
    // Everyone in one of our groups is a member: temporary participants arrive with the
    // mention tool (P3), which is when this becomes a distinction.
    member: true,
    name,
    status: "idle",
  };
}

export function toGroup(input: {
  group: GroupRecord;
  participants: ParticipantRecord[];
  seq: number;
  preview: string;
  lastMessageAt: string | null;
  agentName: (agentId: string) => string;
}): AxpGroup {
  return {
    id: input.group.id,
    name: input.group.name,
    kind: input.group.private ? "direct" : "group",
    goal: input.group.goal,
    decided: input.group.decided,
    archived: false,
    read_seq: input.seq,
    last_seq: input.seq,
    unread: 0,
    preview: input.preview,
    // The group changed whenever its timeline did, which is what a client can tell.
    revision: input.seq,
    last_message_at: input.lastMessageAt,
    updated_at: input.group.updatedAt,
    participants: input.participants.map((participant) =>
      toParticipant(participant, input.agentName(participant.agentId)),
    ),
  };
}

export function toInteraction(interaction: InteractionRecord): AxpInteraction {
  return {
    group_id: interaction.groupId,
    id: interaction.id,
    agent_id: interaction.agentId,
    message_id: interaction.messageId,
    kind: interaction.kind,
    prompt: interaction.prompt,
    options: interaction.options.map((option) => ({
      value: option.value,
      label: option.label,
    })),
    status: interaction.status,
    revision: interaction.revision,
    answer: interaction.answer ?? null,
    created_at: interaction.createdAt,
    updated_at: interaction.updatedAt,
  };
}

export function toAgent(agent: AgentRecord): AxpAgent {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.instructions,
    model: agent.model ?? null,
    bundles: agent.plugins,
    // Nothing is being prepared or built here: a session is opened when it is first woken.
    status: "idle",
    build_error: null,
    revision: 1,
  };
}
