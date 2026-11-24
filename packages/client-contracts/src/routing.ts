/**
 * Who a user message wakes, one rule for the host that routes it and the client that shows it.
 *
 * The host routes with these (`conversations/routing.ts`, Captain's policy); the composer reads them
 * to tell, as it sends, whether the message will wait in the queue because every agent it goes to
 * is still answering. The host's answer stands when the two disagree (a reply ended or started as
 * the message went).
 */
export interface Routing {
  /** Agents to wake, in the order they were named. They are all members. */
  targets: string[];
  /** The members the message named, kept on the row. */
  named: string[];
}

export interface RouteInput {
  /** The members, in the order they joined. */
  members: readonly string[];
  /** The members the message named (`@`), in the order it named them. */
  mentions: readonly string[];
  /** The conversation's steward, or null for none. */
  steward: string | null;
}

const namedMembers = (input: RouteInput) =>
  [...new Set(input.mentions)].filter((id) => input.members.includes(id));

/**
 * A group: the members it names; naming nobody it goes to the steward; a conversation with no
 * steward and a single member has only one reader; anything else wakes nobody. Routing never adds
 * anyone: a steward is a member, and one that is not (it left) is no steward.
 */
export function routeUserMessage(input: RouteInput): Routing {
  const named = namedMembers(input);
  if (named.length > 0) return { targets: named, named };
  if (input.steward !== null && input.members.includes(input.steward))
    return { targets: [input.steward], named };
  if (input.members.length === 1) return { targets: [...input.members], named };
  return { targets: [], named };
}

/** Captain's conversation: there is only Captain to talk to, named or not. */
export function routeCaptainMessage(input: RouteInput): Routing {
  return { targets: [...input.members], named: namedMembers(input) };
}

/** The rule of a conversation's `kind`; a kind the client does not know wakes nobody it can tell. */
export function routeMessage(kind: string, input: RouteInput): Routing {
  if (kind === "captain") return routeCaptainMessage(input);
  if (kind === "group") return routeUserMessage(input);
  return { targets: [], named: [] };
}

/**
 * The agents a message will wait for, or none when it goes straight into the conversation: it is
 * held when it wakes someone and every one of them still has a reply of its own in flight.
 */
export function heldFor(
  targets: readonly string[],
  busy: (agentId: string) => boolean,
): string[] {
  return targets.length > 0 && targets.every(busy) ? [...targets] : [];
}
