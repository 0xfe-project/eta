/**
 * Who a message wakes.
 *
 * Pure rules, so they are read and tested without a database: a user's message wakes the members
 * it names; naming nobody it goes to the steward; a conversation with no steward and a single
 * member has only one reader; anything else wakes nobody, and the sender is told so rather than
 * guessing. Agents may hand work to each other with `mention`, and a conversation must not be
 * able to wake itself for ever: the budget below caps what one user message can start.
 */
import type { ConversationKind } from "@eta/client-contracts";

/** How many agent-to-agent mentions one user message may start, across every branch of replies. */
export const WAKE_BUDGET = 5;

export interface Routing {
  /** Agents to wake, in the order they were named. */
  targets: string[];
  /** The steward is not a member yet and has to be added for the wake. */
  addSteward: boolean;
  /** The members the message named, kept on the row. */
  named: string[];
}

export function routeUserMessage(input: {
  kind: ConversationKind;
  members: readonly string[];
  mentions: readonly string[];
  /** The effective steward: the conversation's own, else the project's. */
  steward: string | null;
}): Routing {
  const named = [...new Set(input.mentions)].filter((id) =>
    input.members.includes(id),
  );
  if (named.length > 0) return { targets: named, addSteward: false, named };
  // A private chat is the agent and the user: nobody else could be meant.
  if (input.kind === "direct") {
    const only = input.members[0];
    return {
      targets: only === undefined ? [] : [only],
      addSteward: false,
      named,
    };
  }
  if (input.steward !== null) {
    return {
      targets: [input.steward],
      addSteward: !input.members.includes(input.steward),
      named,
    };
  }
  if (input.members.length === 1) {
    return { targets: [...input.members], addSteward: false, named };
  }
  return { targets: [], addSteward: false, named };
}

/** What an agent's mention may do, given how many mentions its user message has started. */
export type BudgetVerdict = "wake" | "wake_last" | "capped";

/**
 * `spent` counts the mention being judged. The fifth still wakes, with a reminder alongside it;
 * after that a mention is only context, until the user speaks again and starts a new budget.
 */
export function judgeMention(spent: number): BudgetVerdict {
  if (spent > WAKE_BUDGET) return "capped";
  return spent === WAKE_BUDGET ? "wake_last" : "wake";
}

/**
 * The members an agent named, by id or by name (any case). Names that are nobody's are returned
 * so the agent can be told; the agent itself is never woken by its own message.
 *
 * A name two members answer to goes to Captain if Captain is one of them, then to the first: a
 * user agent called "Captain" from before the name was reserved does not take "@Captain".
 */
export function resolveNamed(
  wanted: readonly string[],
  members: readonly {
    id: string;
    name: string;
    systemRole?: "captain" | null | undefined;
  }[],
  self: string,
): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const raw of wanted) {
    const name = raw.trim().replace(/^@/, "");
    const named = members.filter(
      (member) => member.name.toLowerCase() === name.toLowerCase(),
    );
    const found =
      members.find((member) => member.id === name) ??
      named.find((member) => member.systemRole === "captain") ??
      named[0];
    if (found === undefined) unknown.push(raw);
    else if (found.id !== self && !ids.includes(found.id)) ids.push(found.id);
  }
  return { ids, unknown };
}
