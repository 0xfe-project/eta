/**
 * What kind of conversation this is, and what follows from it.
 *
 * The conversations module carries the machinery every conversation shares: the timeline, replies,
 * streaming, steering, stopping, attachments. Where conversations differ — who a user message goes
 * to, whether members may come and go, whether it is a row of the list, what an agent is told about
 * the room — the module asks the policy of the conversation's `kind`, and knows nothing of the kinds
 * beyond the group, which is its own. Another module that owns a kind of conversation registers its
 * policy when it starts.
 */
import type { AgentRecord } from "../agents/store";
import type { Routing } from "./routing";
import type { ConversationRecord } from "./store";

interface RouteInput {
  /** The members, in the order they joined. */
  members: readonly string[];
  /** The members the message named (`@`), in the order it named them. */
  mentions: readonly string[];
  /** The conversation's steward, or null for none. */
  steward: string | null;
}

/** What an agent's `conversation_info` says about the room, beyond its name, goal and members. */
interface Description {
  /** Said after the conversation's name, in parentheses. */
  note?: string | undefined;
  /** Lines after the members. */
  lines: string[];
}

export interface ConversationPolicy {
  /** The `kind` it is the policy of, as stored on the conversation. */
  readonly kind: string;
  /** Who a user message wakes. */
  route: (input: RouteInput) => Routing;
  /** Whether `conversations.invite`, `remove` and `setSteward` may change who is in it. */
  canChangeMembers: (conversation: ConversationRecord) => boolean;
  /** What the caller is told when `canChangeMembers` says no. */
  readonly membersFixed?: string | undefined;
  /**
   * Why `conversations.update` may not change it (its name, goal, decisions, or whether it is put
   * away), or undefined when it may. `archived` is what the update asks for.
   */
  updateRefusal: (
    conversation: ConversationRecord,
    patch: { archived?: boolean | undefined },
  ) => string | undefined;
  /** Whether it is a row of `conversations.list`. Its own target is there either way. */
  readonly listed: boolean;
  /** What its members are told about it. */
  describe: (conversation: ConversationRecord) => Description;
  /** An agent was renamed: what of this kind carries its name follows. */
  onAgentRenamed?: ((agent: AgentRecord) => void) | undefined;
  /** An agent is being deleted: what of this kind is its own is put away. */
  onAgentDeleted?: ((agent: AgentRecord) => void) | undefined;
}

/**
 * A kind nobody registered: a conversation of a module that is not running on this host. It stays
 * where it is and nothing in it moves.
 */
const unclaimed = (kind: string): ConversationPolicy => ({
  kind,
  route: () => ({ targets: [], named: [] }),
  canChangeMembers: () => false,
  updateRefusal: () => `a ${kind} conversation cannot be changed here`,
  listed: false,
  describe: () => ({ lines: [] }),
});

/** The policies, by kind. */
export class ConversationPolicies {
  readonly #byKind = new Map<string, ConversationPolicy>();

  constructor(policies: readonly ConversationPolicy[] = []) {
    for (const policy of policies) this.register(policy);
  }

  /** Add a kind's policy; the returned function takes it away again. */
  register(policy: ConversationPolicy): () => void {
    if (this.#byKind.has(policy.kind))
      throw new Error(`a policy for ${policy.kind} is already registered`);
    this.#byKind.set(policy.kind, policy);
    return () => {
      if (this.#byKind.get(policy.kind) === policy)
        this.#byKind.delete(policy.kind);
    };
  }

  of(kind: string): ConversationPolicy {
    return this.#byKind.get(kind) ?? unclaimed(kind);
  }

  /** Whether the conversation is a row of the list. */
  listed(conversation: Pick<ConversationRecord, "kind">): boolean {
    return this.of(conversation.kind).listed;
  }

  agentRenamed(agent: AgentRecord): void {
    for (const policy of this.#byKind.values()) policy.onAgentRenamed?.(agent);
  }

  agentDeleted(agent: AgentRecord): void {
    for (const policy of this.#byKind.values()) policy.onAgentDeleted?.(agent);
  }
}
